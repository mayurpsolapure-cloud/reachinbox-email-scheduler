import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { pool } from "../config/database.js";
import {
  redisConnection,
  slackNotificationQueue,
} from "../queue/email.queue.js";

const RATE_LIMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local maxEmails = tonumber(ARGV[2])
local minDelay = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])

local count = tonumber(redis.call("GET", KEYS[1]) or "0")
local lastSent = tonumber(redis.call("GET", KEYS[2]) or "0")
local waitForDelay = 0
local waitForLimit = 0
local limited = 0

if lastSent > 0 and (now - lastSent) < minDelay then
  waitForDelay = minDelay - (now - lastSent)
end

if count >= maxEmails then
  waitForLimit = windowMs - (now % windowMs)
  limited = 1
end

local waitTime = math.max(waitForDelay, waitForLimit)
if waitTime > 0 then
  return { waitTime, limited }
end

local newCount = redis.call("INCR", KEYS[1])
if newCount == 1 then
  redis.call("EXPIRE", KEYS[1], math.max(2, math.ceil(windowMs / 1000) * 2))
end
redis.call("SET", KEYS[2], now, "EX", math.max(3600, math.ceil(windowMs / 1000) * 2))

return { 0, 0 }
`;

export type RateLimitContext = {
  userId: string;
  emailAccountId: string | null;
  senderEmail: string;
};

export type SenderCapacityResult = {
  acquired: boolean;
  waitMs: number;
  rateLimited: boolean;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveIntegerEnv(name: string, defaultValue: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function nonNegativeNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

async function enqueueRateLimitNotification(
  senderId: string,
  context: RateLimitContext,
  hourlyLimit: number,
  windowBucket: number,
  windowMs: number,
  eventAt: Date
): Promise<void> {
  const senderHash = hash(senderId);
  const tenantSenderHash = hash(`${context.userId}:${senderId}`);
  const dedupeKey = `slack-rate-limit:${tenantSenderHash}:${windowBucket}`;
  let claimed = false;
  try {
    const dedupe = await redisConnection.set(
      dedupeKey,
      "1",
      "EX",
      Math.max(60, Math.ceil(windowMs / 1000) * 2),
      "NX"
    );
    if (dedupe !== "OK") return;
    claimed = true;

    const result = await pool.query<{ delayed_count: string }>(
      `SELECT COUNT(*)::text AS delayed_count
       FROM scheduled_emails se
       JOIN campaigns c ON c.id = se.campaign_id
       WHERE c.user_id = $1
         AND se.status IN ('pending', 'queued')
         AND (($2::uuid IS NULL
               AND se.email_account_id IS NULL
               AND c.email_account_id IS NULL)
           OR COALESCE(se.email_account_id, c.email_account_id) = $2::uuid)`,
      [context.userId, context.emailAccountId]
    );
    const jobId = `rate-limit-${tenantSenderHash}-${windowBucket}`;
    await slackNotificationQueue.add(
      "sender-hourly-limit",
      {
        userId: context.userId,
        senderEmail: context.senderEmail,
        hourlyLimit,
        eventAt: eventAt.toISOString(),
        delayedEmails: Number(result.rows[0]?.delayed_count ?? 0),
      },
      { jobId }
    );
  } catch (error) {
    if (claimed) {
      try {
        await redisConnection.del(dedupeKey);
      } catch (deleteError) {
        console.error("Could not release Slack notification deduplication key:", deleteError);
      }
    }
    console.error("Could not enqueue Slack rate-limit notification:", error);
  }
}

export async function acquireSenderCapacity(
  senderId: string,
  context: RateLimitContext,
  redis: Redis = redisConnection
): Promise<SenderCapacityResult> {
  const hourlyLimit = positiveIntegerEnv(
    "MAX_EMAILS_PER_SENDER_PER_HOUR",
    100
  );
  const minimumDelayMs = nonNegativeNumberEnv("MIN_EMAIL_DELAY_MS", 2000);
  const windowMs = positiveIntegerEnv(
    "SENDER_RATE_LIMIT_WINDOW_MS",
    3_600_000,
    1000
  );
  const now = Date.now();
  const windowBucket = Math.floor(now / windowMs);
  const senderHash = hash(senderId);
  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    2,
    `email-rate:${senderHash}:${windowBucket}`,
    `email-delay:${senderHash}`,
    String(now),
    String(hourlyLimit),
    String(minimumDelayMs),
    String(windowMs)
  ) as [number | string, number | string];

  const waitMs = Number(result[0]);
  const rateLimited = Number(result[1]) === 1;
  if (rateLimited) {
    void enqueueRateLimitNotification(
      senderId,
      context,
      hourlyLimit,
      windowBucket,
      windowMs,
      new Date(now)
    );
  }
  return { acquired: waitMs <= 0, waitMs, rateLimited };
}
