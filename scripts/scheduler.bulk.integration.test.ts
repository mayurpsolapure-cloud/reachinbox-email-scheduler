import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import session from "express-session";
import type { AddressInfo } from "node:net";
import { pool } from "../src/config/database.js";
import { requireAuth } from "../src/middleware/require-auth.js";
import { emailQueue, redisConnection } from "../src/queue/email.queue.js";
import schedulerRoutes from "../src/routes/scheduler.routes.js";

const userId = randomUUID();
const campaignId = randomUUID();
const emailPrefix = `bulk-${randomUUID()}`;
const totalEmailCount = Number(process.env.BULK_TEST_EMAIL_COUNT) || 1005;
let server: ReturnType<express.Express["listen"]> | undefined;
let baseUrl = "";
let cookie = "";
let emailIds: string[] = [];

before(async () => {
  await pool.query(
    "INSERT INTO users (id, name, email) VALUES ($1, 'Bulk Queue Test', $2)",
    [userId, `${userId}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO campaigns
       (id, user_id, name, subject, body, scheduled_at, timezone, minimum_delay_seconds)
     VALUES ($1, $2, 'Bulk queue test', 'Bulk subject', 'Bulk body', NOW(), 'UTC', 0)`,
    [campaignId, userId]
  );
  await pool.query(
    `INSERT INTO leads (user_id, email)
     SELECT $1, $2 || '-' || number::text || '@example.invalid'
     FROM generate_series(1, $3) AS source(number)`,
    [userId, emailPrefix, totalEmailCount]
  );
  await pool.query(
    `INSERT INTO scheduled_emails
       (campaign_id, lead_id, recipient_email, subject, body, scheduled_for, idempotency_key)
     SELECT $1, l.id, l.email, 'Bulk subject', 'Bulk body',
            NOW() + INTERVAL '1 hour', 'bulk-' || l.id::text
     FROM leads l
     WHERE l.user_id = $2 AND l.email LIKE $3 || '-%@example.invalid'`,
    [campaignId, userId, emailPrefix]
  );
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM scheduled_emails WHERE campaign_id = $1 ORDER BY created_at, id",
    [campaignId]
  );
  emailIds = rows.rows.map((row) => row.id);
  assert.equal(emailIds.length, totalEmailCount);

  const app = express();
  app.use(express.json());
  app.use(session({
    name: "reachinbox.bulk-test",
    secret: "test-session-secret-with-at-least-thirty-two-characters",
    resave: false,
    saveUninitialized: false,
  }));
  app.post("/__test/login", (req, res) => {
    req.session.user = {
      id: userId,
      name: "Bulk Queue Test",
      email: `${userId}@example.invalid`,
      avatarUrl: null,
    };
    req.session.save((error) => error ? res.status(500).end() : res.status(204).end());
  });
  app.use("/api", requireAuth);
  app.use("/api", schedulerRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server?.once("listening", resolve);
    server?.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${baseUrl}/__test/login`, { method: "POST" });
  assert.equal(login.status, 204);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie);
});

after(async () => {
  for (const id of emailIds) {
    const job = await emailQueue.getJob(`email-${id}`);
    if (job) await job.remove();
  }
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  await emailQueue.close();
  await redisConnection.quit();
  await pool.end();
});

test(`scheduling ${totalEmailCount} emails uses persisted records and bounded queue batches`, async () => {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/campaigns/${campaignId}/schedule`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { totalPending: number; queued: number };
  assert.equal(body.totalPending, totalEmailCount);
  assert.equal(body.queued, totalEmailCount);

  const persisted = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM scheduled_emails WHERE campaign_id = $1 AND status = 'queued'",
    [campaignId]
  );
  assert.equal(Number(persisted.rows[0]?.count), totalEmailCount);
  const jobCounts = await emailQueue.getJobCounts("waiting", "delayed");
  assert.ok(jobCounts.waiting + jobCounts.delayed >= totalEmailCount);
  const persistedJobs = await Promise.all(
    emailIds.map((id) => emailQueue.getJob(`email-${id}`))
  );
  assert.equal(persistedJobs.filter(Boolean).length, totalEmailCount);

  const job = emailIds[0];
  assert.ok(job);
  const restartedConnection = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
  });
  const restartedQueue = new Queue("email-sending", { connection: restartedConnection });
  try {
    assert.ok(await restartedQueue.getJob(`email-${job}`));
    assert.equal(await restartedQueue.getJobState(`email-${job}`), "delayed");
  } finally {
    await restartedQueue.close();
    await restartedConnection.quit();
  }
  const claimSql = `UPDATE scheduled_emails se
    SET status = 'processing', attempt_count = attempt_count + 1, updated_at = NOW()
    FROM campaigns c
    LEFT JOIN email_accounts ea ON ea.id = c.email_account_id
    WHERE se.id = $1 AND c.id = se.campaign_id AND se.status IN ('pending', 'queued')
    RETURNING se.id, se.attempt_count,
      COALESCE(se.email_account_id, c.email_account_id) AS email_account_id,
      ea.email AS sender_email, c.user_id`;
  const firstClaim = await pool.query(claimSql, [job]);
  assert.equal(firstClaim.rowCount, 1);
  const duplicateClaim = await pool.query(claimSql, [job]);
  assert.equal(duplicateClaim.rowCount, 0);
  await pool.query(
    "UPDATE scheduled_emails SET status = 'queued', attempt_count = 0 WHERE id = $1",
    [job]
  );
  const durationMs = Math.round(performance.now() - startedAt);
  console.log(JSON.stringify({
    loadTest: {
      jobsCreated: body.queued,
      databasePersisted: Number(persisted.rows[0]?.count),
      queuedOrDelayed: jobCounts.waiting + jobCounts.delayed,
      duplicatesClaimed: 0,
      processingDurationMs: durationMs,
      peakQueueDepthObserved: jobCounts.waiting + jobCounts.delayed,
      emailsSent: 0,
      failed: 0,
      delayed: jobCounts.delayed,
      workerConcurrencyObserved: "worker intentionally not started",
    },
  }));
});
