import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pool } from "../config/database.js";
import type { SlackNotificationData } from "../queue/email.queue.js";

export type SlackWebhookDetails = {
  teamId: string;
  teamName: string | null;
  channelId: string;
  channelName: string;
  webhookUrl: string;
};

type SlackOAuthResponse = {
  ok: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: {
    url?: string;
    channel_id?: string;
    channel?: string;
  };
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function encryptionKey(): Buffer {
  const value = requiredEnv("SLACK_WEBHOOK_ENCRYPTION_KEY");
  if (!/^[\da-fA-F]{64}$/.test(value)) {
    throw new Error("SLACK_WEBHOOK_ENCRYPTION_KEY must be 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

function encryptWebhookUrl(webhookUrl: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(webhookUrl, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decryptWebhookUrl(value: string): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Stored Slack webhook encryption is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function validateWebhookUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    url.username ||
    url.password ||
    !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(url.pathname)
  ) {
    throw new Error("Slack returned an invalid incoming webhook URL");
  }
  return url.toString();
}

function validateSlackConfiguration(): void {
  requiredEnv("SLACK_CLIENT_ID");
  requiredEnv("SLACK_CLIENT_SECRET");
  const redirectUri = new URL(requiredEnv("SLACK_REDIRECT_URI"));
  if (process.env.NODE_ENV === "production" && redirectUri.protocol !== "https:") {
    throw new Error("SLACK_REDIRECT_URI must use HTTPS in production");
  }
  encryptionKey();
}

export function createSlackAuthorizationUrl(state: string): string {
  validateSlackConfiguration();
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requiredEnv("SLACK_CLIENT_ID"));
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("redirect_uri", requiredEnv("SLACK_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackAuthorizationCode(
  code: string,
  fetcher: typeof fetch = fetch
): Promise<SlackWebhookDetails> {
  const body = new URLSearchParams({
    client_id: requiredEnv("SLACK_CLIENT_ID"),
    client_secret: requiredEnv("SLACK_CLIENT_SECRET"),
    code,
    redirect_uri: requiredEnv("SLACK_REDIRECT_URI"),
  });
  const response = await fetcher("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Slack token exchange failed");

  const result = (await response.json()) as SlackOAuthResponse;
  const webhookUrl = result.incoming_webhook?.url;
  const teamId = result.team?.id;
  const channelId = result.incoming_webhook?.channel_id;
  const channelName = result.incoming_webhook?.channel;
  if (!result.ok || !teamId || !channelId || !channelName || !webhookUrl) {
    throw new Error("Slack did not grant an incoming webhook");
  }

  return {
    teamId,
    teamName: result.team?.name ?? null,
    channelId,
    channelName,
    webhookUrl: validateWebhookUrl(webhookUrl),
  };
}

export async function saveSlackConnection(
  userId: string,
  details: SlackWebhookDetails
): Promise<void> {
  const webhookCiphertext = encryptWebhookUrl(validateWebhookUrl(details.webhookUrl));
  await pool.query(
    `INSERT INTO slack_integrations
       (user_id, team_id, team_name, channel_id, channel_name, webhook_ciphertext, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected')
     ON CONFLICT (user_id) DO UPDATE SET
       team_id = EXCLUDED.team_id,
       team_name = EXCLUDED.team_name,
       channel_id = EXCLUDED.channel_id,
       channel_name = EXCLUDED.channel_name,
       webhook_ciphertext = EXCLUDED.webhook_ciphertext,
       status = 'connected',
       updated_at = NOW()`,
    [
      userId,
      details.teamId,
      details.teamName,
      details.channelId,
      details.channelName,
      webhookCiphertext,
    ]
  );
}

export async function getSlackConnectionStatus(userId: string) {
  const result = await pool.query<{
    team_name: string | null;
    channel_name: string;
    created_at: Date;
  }>(
    `SELECT team_name, channel_name, created_at
     FROM slack_integrations
     WHERE user_id = $1 AND status = 'connected'`,
    [userId]
  );
  const connection = result.rows[0];
  if (!connection) return { connected: false as const };
  return {
    connected: true as const,
    teamName: connection.team_name,
    channelName: connection.channel_name,
    connectedAt: connection.created_at,
  };
}

export async function disconnectSlack(userId: string): Promise<void> {
  await pool.query(
    `UPDATE slack_integrations
     SET status = 'disconnected',
         webhook_ciphertext = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

export async function sendSlackRateLimitNotification(
  notification: SlackNotificationData,
  fetcher: typeof fetch = fetch
): Promise<"sent" | "not-connected"> {
  const result = await pool.query<{ webhook_ciphertext: string }>(
    `SELECT webhook_ciphertext
     FROM slack_integrations
     WHERE user_id = $1 AND status = 'connected'
     LIMIT 1`,
    [notification.userId]
  );
  const encrypted = result.rows[0]?.webhook_ciphertext;
  if (!encrypted) return "not-connected";

  const webhookUrl = validateWebhookUrl(decryptWebhookUrl(encrypted));
  const date = new Date(notification.eventAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const delayedDescription = notification.delayedEmails > 0
    ? `${notification.delayedEmails} remaining email${notification.delayedEmails === 1 ? "" : "s"} ${notification.delayedEmails === 1 ? "is" : "are"} delayed until capacity becomes available.`
    : "Remaining emails are delayed until capacity becomes available.";
  const response = await fetcher(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: [
        "⚠️ ReachInbox: Hourly sending limit reached.",
        `Sender: ${notification.senderEmail}`,
        `Limit: ${notification.hourlyLimit} emails/hour`,
        `Time (UTC): ${date}`,
        delayedDescription,
      ].join("\n"),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
  const responseText = await response.text();
  if (responseText.trim().toLowerCase() !== "ok") {
    throw new Error("Slack webhook rejected the notification");
  }
  return "sent";
}
