import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import { pool } from "../src/config/database.js";
import { elasticsearchClient } from "../src/config/elasticsearch.js";
import { emailQueue, redisConnection } from "../src/queue/email.queue.js";
import campaignRoutes from "../src/routes/campaign.routes.js";
import leadRoutes from "../src/routes/lead.routes.js";
import schedulerRoutes from "../src/routes/scheduler.routes.js";
import searchRoutes from "../src/routes/search.routes.js";
import { indexSentEmail } from "../src/services/email-search.service.js";
import { requireAuth } from "../src/middleware/require-auth.js";
import type { AuthenticatedUser } from "../src/types/express-session.js";

const userAId = randomUUID();
const userBId = randomUUID();
const campaignBId = randomUUID();
const indexedEmailId = randomUUID();
const marker = `oauthisolation${randomUUID().replace(/-/g, "")}`;
let campaignAId = "";
let scheduledEmailId = "";
let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";

before(async () => {
  await pool.query(
    `INSERT INTO users (id, name, email)
     VALUES ($1, 'OAuth API Test A', $2), ($3, 'OAuth API Test B', $4)`,
    [userAId, `api-test-a-${userAId}@example.invalid`, userBId, `api-test-b-${userBId}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO gmail_authorizations
       (user_id, gmail_email, google_sub, refresh_token_ciphertext,
        refresh_token_nonce, refresh_token_tag, status, authorized_at)
     VALUES
       ($1, $2, $3, 'ciphertext', '000000000000000000000000', '00000000000000000000000000000000', 'connected', NOW()),
       ($4, $5, $6, 'ciphertext', '000000000000000000000000', '00000000000000000000000000000000', 'connected', NOW())`,
    [
      userAId,
      `api-test-a-${userAId}@example.invalid`,
      `google-${userAId}`,
      userBId,
      `api-test-b-${userBId}@example.invalid`,
      `google-${userBId}`,
    ]
  );
  await pool.query(
    `INSERT INTO campaigns
       (id, user_id, name, subject, body, scheduled_at, timezone, minimum_delay_seconds)
     VALUES ($1, $2, 'Other user campaign', 'Other user', 'Private content', NOW(), 'UTC', 0)`,
    [campaignBId, userBId]
  );

  const app = express();
  app.use(express.json());
  app.use(session({
    name: "reachinbox.sid",
    secret: "test-session-secret-with-at-least-thirty-two-characters",
    resave: false,
    saveUninitialized: false,
  }));
  app.post("/__test/login", async (req, res) => {
    const userId = req.body.userId as string;
    const result = await pool.query<{ id: string; name: string; email: string }>(
      "SELECT id, name, email FROM users WHERE id = $1",
      [userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).end();
    req.session.user = { ...user, avatarUrl: null };
    return req.session.save((error) => error ? res.status(500).end() : res.status(204).end());
  });
  app.use("/api", requireAuth);
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/leads", leadRoutes);
  app.use("/api", schedulerRoutes);
  app.use("/api", searchRoutes);

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (scheduledEmailId) {
    const job = await emailQueue.getJob(`email-${scheduledEmailId}`);
    if (job) await job.remove();
  }
  await elasticsearchClient.delete({ index: "sent-emails", id: indexedEmailId }).catch(() => undefined);
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userAId, userBId]]);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await elasticsearchClient.close();
  await emailQueue.close();
  await redisConnection.quit();
  await pool.end();
});

async function login(userId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/__test/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

test("authenticated campaign ownership, lead import, scheduling, and search isolation", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/campaigns`);
  assert.equal(unauthenticated.status, 401);

  const cookie = await login(userAId);
  const scheduleAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const create = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Owned campaign",
      subject: "Owned subject",
      body: "Owned message",
      scheduledAt: scheduleAt,
      timezone: "UTC",
      minimumDelaySeconds: 0,
    }),
  });
  assert.equal(create.status, 201);
  const campaign = (await create.json()).campaign as { id: string };
  campaignAId = campaign.id;

  const list = await fetch(`${baseUrl}/api/campaigns`, { headers: { cookie } });
  const campaigns = (await list.json()).campaigns as { id: string }[];
  assert.deepEqual(campaigns.map((item) => item.id), [campaignAId]);

  const privateCampaign = await fetch(`${baseUrl}/api/campaigns/${campaignBId}`, { headers: { cookie } });
  assert.equal(privateCampaign.status, 404);

  const form = new FormData();
  form.append("campaignId", campaignAId);
  form.append("file", new Blob(["email\nlead@example.invalid\n"], { type: "text/csv" }), "leads.csv");
  const imported = await fetch(`${baseUrl}/api/leads/import`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).scheduledEmailsCreated, 1);
  const emailResult = await pool.query<{ id: string }>(
    "SELECT id FROM scheduled_emails WHERE campaign_id = $1",
    [campaignAId]
  );
  scheduledEmailId = emailResult.rows[0]?.id ?? "";
  assert.ok(scheduledEmailId);

  const scheduled = await fetch(`${baseUrl}/api/campaigns/${campaignAId}/schedule`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(scheduled.status, 200);
  assert.equal((await scheduled.json()).queued, 1);

  await indexSentEmail({
    emailId: indexedEmailId,
    campaignId: campaignBId,
    recipientEmail: "private@example.invalid",
    subject: marker,
    body: "private search fixture",
    senderId: "test",
    status: "sent",
    sentAt: new Date().toISOString(),
  });
  const searchA = await fetch(`${baseUrl}/api/search/emails?q=${marker}`, { headers: { cookie } });
  assert.equal(searchA.status, 200);
  assert.equal((await searchA.json()).count, 0);

  const cookieB = await login(userBId);
  const searchB = await fetch(`${baseUrl}/api/search/emails?q=${marker}`, { headers: { cookie: cookieB } });
  assert.equal(searchB.status, 200);
  assert.equal((await searchB.json()).count, 1);
});
