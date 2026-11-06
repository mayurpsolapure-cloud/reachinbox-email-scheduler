import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "../src/config/database.js";
import {
  disconnectSlack,
  getSlackConnectionStatus,
  saveSlackConnection,
  sendSlackRateLimitNotification,
} from "../src/services/slack.service.js";

process.env.SLACK_WEBHOOK_ENCRYPTION_KEY = randomBytes(32).toString("hex");

test("Slack webhook is encrypted, tenant-scoped, refreshed on reconnect, and disabled on disconnect", async () => {
  const userId = randomUUID();
  const secondUserId = randomUUID();
  const email = `slack-${userId}@example.invalid`;
  const secondEmail = `slack-${secondUserId}@example.invalid`;
  const firstUrl = "https://hooks.slack.com/services/T111/B111/tokenone";
  const secondUrl = "https://hooks.slack.com/services/T222/B222/tokentwo";
  const notification = {
    userId,
    senderEmail: "sender@example.invalid",
    hourlyLimit: 100,
    eventAt: new Date().toISOString(),
    delayedEmails: 17,
  };

  try {
    await pool.query(
      `INSERT INTO users (id, name, email)
       VALUES ($1, 'Slack Integration Test', $2), ($3, 'Slack Integration Test Two', $4)`,
      [userId, email, secondUserId, secondEmail]
    );
    await saveSlackConnection(userId, {
      teamId: "T111",
      teamName: "First Workspace",
      channelId: "C111",
      channelName: "alerts",
      webhookUrl: firstUrl,
    });
    await saveSlackConnection(secondUserId, {
      teamId: "T333",
      teamName: "Isolated Workspace",
      channelId: "C333",
      channelName: "private-alerts",
      webhookUrl: "https://hooks.slack.com/services/T333/B333/tokenthree",
    });
    await saveSlackConnection(userId, {
      teamId: "T111",
      teamName: "First Workspace",
      channelId: "C111",
      channelName: "alerts",
      webhookUrl: firstUrl,
    });
    const connectionCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM slack_integrations WHERE user_id = $1 AND status = 'connected'",
      [userId]
    );
    assert.equal(Number(connectionCount.rows[0]?.count), 1);

    const stored = await pool.query<{ webhook_ciphertext: string }>(
      "SELECT webhook_ciphertext FROM slack_integrations WHERE user_id = $1",
      [userId]
    );
    assert.ok(stored.rows[0]?.webhook_ciphertext);
    assert.equal(stored.rows[0]?.webhook_ciphertext.includes(firstUrl), false);

    const status = await getSlackConnectionStatus(userId);
    assert.equal(status.connected, true);
    if (status.connected) {
      assert.equal(status.channelName, "alerts");
      assert.equal("webhookUrl" in status, false);
    }

    let postedUrl = "";
    let postedBody = "";
    const mockSlack = async (input: RequestInfo | URL, init?: RequestInit) => {
      postedUrl = String(input);
      postedBody = String(init?.body ?? "");
      return new Response("ok", { status: 200 });
    };
    assert.equal(await sendSlackRateLimitNotification(notification, mockSlack), "sent");
    assert.equal(postedUrl, firstUrl);
    assert.match(postedBody, /sender@example\.invalid/);
    assert.match(postedBody, /100 emails\/hour/);
    assert.match(postedBody, /17 remaining emails/);

    for (const statusCode of [400, 403, 404, 429, 500]) {
      await assert.rejects(
        sendSlackRateLimitNotification(
          notification,
          async () => new Response("rejected", { status: statusCode })
        ),
        new RegExp(`HTTP ${statusCode}`)
      );
    }
    await assert.rejects(
      sendSlackRateLimitNotification(notification, async () => {
        throw new TypeError("fetch failed");
      }),
      /fetch failed/
    );
    await assert.rejects(
      sendSlackRateLimitNotification(
        notification,
        async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
        })
      ),
      /timed out|timeout/i
    );
    const encryptionKey = process.env.SLACK_WEBHOOK_ENCRYPTION_KEY;
    delete process.env.SLACK_WEBHOOK_ENCRYPTION_KEY;
    await assert.rejects(sendSlackRateLimitNotification(notification), /SLACK_WEBHOOK_ENCRYPTION_KEY/);
    if (encryptionKey) process.env.SLACK_WEBHOOK_ENCRYPTION_KEY = encryptionKey;

    await pool.query(
      "UPDATE slack_integrations SET webhook_ciphertext = 'invalid' WHERE user_id = $1",
      [userId]
    );
    await assert.rejects(sendSlackRateLimitNotification(notification), /encryption is invalid/);
    await saveSlackConnection(userId, {
      teamId: "T111",
      teamName: "First Workspace",
      channelId: "C111",
      channelName: "alerts",
      webhookUrl: firstUrl,
    });

    await disconnectSlack(userId);
    let calledAfterDisconnect = false;
    assert.equal(
      await sendSlackRateLimitNotification(notification, async () => {
        calledAfterDisconnect = true;
        return new Response("ok");
      }),
      "not-connected"
    );
    assert.equal(calledAfterDisconnect, false);
    assert.equal((await getSlackConnectionStatus(secondUserId)).connected, true);

    await saveSlackConnection(userId, {
      teamId: "T222",
      teamName: "Second Workspace",
      channelId: "C222",
      channelName: "email-alerts",
      webhookUrl: secondUrl,
    });
    assert.equal(await sendSlackRateLimitNotification(notification, mockSlack), "sent");
    assert.equal(postedUrl, secondUrl);
    const reconnectedStatus = await getSlackConnectionStatus(userId);
    assert.equal(reconnectedStatus.connected, true);
    if (reconnectedStatus.connected) {
      assert.equal(reconnectedStatus.teamName, "Second Workspace");
      assert.equal(reconnectedStatus.channelName, "email-alerts");
    }
  } finally {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userId, secondUserId]]);
    await pool.end();
  }
});
