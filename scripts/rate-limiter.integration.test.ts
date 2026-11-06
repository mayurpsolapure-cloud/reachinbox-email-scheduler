import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Redis } from "ioredis";
import {
  emailQueue,
  redisConnection,
  slackNotificationQueue,
} from "../src/queue/email.queue.js";
import { acquireSenderCapacity } from "../src/services/rate-limiter.service.js";
import { pool } from "../src/config/database.js";

process.env.MAX_EMAILS_PER_SENDER_PER_HOUR = "10";
process.env.MIN_EMAIL_DELAY_MS = "0";
process.env.SENDER_RATE_LIMIT_WINDOW_MS = "3600000";

const userId = randomUUID();
const secondUserId = randomUUID();
const senderId = `rate-test-${randomUUID()}`;
const otherSenderId = `rate-test-other-${randomUUID()}`;
const expiringSenderId = `rate-test-expiring-${randomUUID()}`;
const delayedSenderId = `rate-test-min-delay-${randomUUID()}`;
const multiClientSenderId = `rate-test-multi-client-${randomUUID()}`;
const windowMs = 3_600_000;
const bucket = Math.floor(Date.now() / windowMs);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tenantSenderHash = digest(`${userId}:${senderId}`);
const secondTenantSenderHash = digest(`${secondUserId}:${senderId}`);
const dedupeKey = `slack-rate-limit:${tenantSenderHash}:${bucket}`;
const secondTenantDedupeKey = `slack-rate-limit:${secondTenantSenderHash}:${bucket}`;
const rateKey = `email-rate:${digest(senderId)}:${bucket}`;
const delayKey = `email-delay:${digest(senderId)}`;
const slackJobId = `rate-limit-${tenantSenderHash}-${bucket}`;
const secondTenantSlackJobId = `rate-limit-${secondTenantSenderHash}-${bucket}`;
const multiClientTenantSenderHash = digest(`${userId}:${multiClientSenderId}`);
const multiClientBucket = Math.floor(Date.now() / windowMs);
const multiClientJobId = `rate-limit-${multiClientTenantSenderHash}-${multiClientBucket}`;
const multiClientDedupeKey = `slack-rate-limit:${multiClientTenantSenderHash}:${multiClientBucket}`;
const multiClientRateKey = `email-rate:${digest(multiClientSenderId)}:${multiClientBucket}`;
const multiClientDelayKey = `email-delay:${digest(multiClientSenderId)}`;
let expiringNotificationId = "";
let expiringDedupeRedisKey = "";
let expiringRateRedisKey = "";
let expiringDelayRedisKey = "";
let minimumDelayRateKey = "";
let minimumDelayRedisKey = "";

after(async () => {
  const notification = await slackNotificationQueue.getJob(slackJobId);
  const secondTenantNotification = await slackNotificationQueue.getJob(secondTenantSlackJobId);
  const multiClientNotification = await slackNotificationQueue.getJob(multiClientJobId);
  const expiringNotification = expiringNotificationId
    ? await slackNotificationQueue.getJob(expiringNotificationId)
    : undefined;
  if (notification) await notification.remove();
  if (secondTenantNotification) await secondTenantNotification.remove();
  if (multiClientNotification) await multiClientNotification.remove();
  if (expiringNotification) await expiringNotification.remove();
  await redisConnection.del(
    dedupeKey,
    secondTenantDedupeKey,
    multiClientDedupeKey,
    multiClientRateKey,
    multiClientDelayKey,
    `email-rate:${digest(otherSenderId)}:${bucket}`,
    `email-delay:${digest(otherSenderId)}`,
    expiringRateRedisKey,
    expiringDelayRedisKey,
    minimumDelayRateKey,
    minimumDelayRedisKey,
    rateKey,
    delayKey,
    expiringDedupeRedisKey
  );
  await Promise.all([emailQueue.close(), slackNotificationQueue.close()]);
  await redisConnection.quit();
  await pool.end();
});

test("1,000 concurrent acquisitions obey sender limits and deduplicate notifications", async () => {
  const attempts = await Promise.all(
    Array.from({ length: 1000 }, () =>
      acquireSenderCapacity(senderId, {
        userId,
        emailAccountId: null,
        senderEmail: "sender@example.invalid",
      })
    )
  );
  assert.equal(attempts.filter((attempt) => attempt.acquired).length, 10);
  assert.equal(attempts.filter((attempt) => attempt.rateLimited).length, 990);
  assert.ok(attempts.every((attempt) => attempt.waitMs >= 0));

  const independentSender = await acquireSenderCapacity(otherSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "other-sender@example.invalid",
  });
  assert.equal(independentSender.acquired, true);

  let notificationJob = await slackNotificationQueue.getJob(slackJobId);
  for (let retry = 0; !notificationJob && retry < 40; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    notificationJob = await slackNotificationQueue.getJob(slackJobId);
  }
  assert.ok(notificationJob, "the first rate-limit event queues a Slack notification");
  assert.equal(await redisConnection.get(dedupeKey), "1");

  await acquireSenderCapacity(senderId, {
    userId: secondUserId,
    emailAccountId: null,
    senderEmail: "sender@example.invalid",
  });
  let secondTenantJob = await slackNotificationQueue.getJob(secondTenantSlackJobId);
  for (let retry = 0; !secondTenantJob && retry < 40; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    secondTenantJob = await slackNotificationQueue.getJob(secondTenantSlackJobId);
  }
  assert.ok(secondTenantJob, "the same sender can notify a different tenant independently");

  const redisClients = Array.from({ length: 4 }, () =>
    new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: null,
    })
  );
  try {
    const distributedAttempts = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        acquireSenderCapacity(
          multiClientSenderId,
          {
            userId,
            emailAccountId: null,
            senderEmail: "multi-client@example.invalid",
          },
          redisClients[index % redisClients.length]!
        )
      )
    );
    assert.equal(
      distributedAttempts.filter((attempt) => attempt.acquired).length,
      10
    );
  } finally {
    await Promise.all(redisClients.map((client) => client.quit()));
  }
  const restartedClient = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
  });
  try {
    assert.equal(await restartedClient.get(multiClientRateKey), "10");
  } finally {
    await restartedClient.quit();
  }
  let multiClientNotification = await slackNotificationQueue.getJob(multiClientJobId);
  for (let retry = 0; !multiClientNotification && retry < 40; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    multiClientNotification = await slackNotificationQueue.getJob(multiClientJobId);
  }
  assert.ok(multiClientNotification, "independent Redis clients deduplicate the same window notification");

  process.env.MAX_EMAILS_PER_SENDER_PER_HOUR = "2";
  process.env.SENDER_RATE_LIMIT_WINDOW_MS = "1000";
  while (Date.now() % 1000 > 100) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const expiringBucket = Math.floor(Date.now() / 1000);
  const expiringTenantSenderHash = digest(`${userId}:${expiringSenderId}`);
  expiringNotificationId = `rate-limit-${expiringTenantSenderHash}-${expiringBucket}`;
  expiringDedupeRedisKey = `slack-rate-limit:${expiringTenantSenderHash}:${expiringBucket}`;
  expiringRateRedisKey = `email-rate:${digest(expiringSenderId)}:${expiringBucket}`;
  expiringDelayRedisKey = `email-delay:${digest(expiringSenderId)}`;
  const expiring = await Promise.all([
    acquireSenderCapacity(expiringSenderId, {
      userId,
      emailAccountId: null,
      senderEmail: "window@example.invalid",
    }),
    acquireSenderCapacity(expiringSenderId, {
      userId,
      emailAccountId: null,
      senderEmail: "window@example.invalid",
    }),
  ]);
  assert.ok(expiring.every((attempt) => attempt.acquired));
  const blocked = await acquireSenderCapacity(expiringSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "window@example.invalid",
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.rateLimited, true);
  assert.ok(blocked.waitMs > 0 && blocked.waitMs <= 1000);
  await new Promise((resolve) => setTimeout(resolve, blocked.waitMs + 20));
  const afterWindow = await acquireSenderCapacity(expiringSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "window@example.invalid",
  });
  assert.equal(afterWindow.acquired, true);

  process.env.SENDER_RATE_LIMIT_WINDOW_MS = "3600000";
  process.env.MAX_EMAILS_PER_SENDER_PER_HOUR = "10";
  process.env.MIN_EMAIL_DELAY_MS = "120";
  const minimumDelayBucket = Math.floor(Date.now() / 3_600_000);
  minimumDelayRateKey = `email-rate:${digest(delayedSenderId)}:${minimumDelayBucket}`;
  minimumDelayRedisKey = `email-delay:${digest(delayedSenderId)}`;
  const firstDelayed = await acquireSenderCapacity(delayedSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "minimum-delay@example.invalid",
  });
  assert.equal(firstDelayed.acquired, true);
  const minimumDelay = await acquireSenderCapacity(delayedSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "minimum-delay@example.invalid",
  });
  assert.equal(minimumDelay.acquired, false);
  assert.equal(minimumDelay.rateLimited, false);
  assert.ok(minimumDelay.waitMs > 0 && minimumDelay.waitMs <= 120);
  await new Promise((resolve) => setTimeout(resolve, minimumDelay.waitMs + 10));
  const afterDelay = await acquireSenderCapacity(delayedSenderId, {
    userId,
    emailAccountId: null,
    senderEmail: "minimum-delay@example.invalid",
  });
  assert.equal(afterDelay.acquired, true);

  const previousLimit = process.env.MAX_EMAILS_PER_SENDER_PER_HOUR;
  process.env.MAX_EMAILS_PER_SENDER_PER_HOUR = "not-a-number";
  await assert.rejects(
    acquireSenderCapacity(`invalid-config-${randomUUID()}`, {
      userId,
      emailAccountId: null,
      senderEmail: "invalid@example.invalid",
    }),
    /MAX_EMAILS_PER_SENDER_PER_HOUR/
  );
  process.env.MAX_EMAILS_PER_SENDER_PER_HOUR = previousLimit;
});
