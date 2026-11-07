import { DelayedError, Worker } from "bullmq";
import type { PoolClient } from "pg";
import { pool } from "../config/database.js";
import { createRedisConnection } from "../config/redis.js";
import {
  slackNotificationQueue,
  type SlackNotificationData,
} from "../queue/email.queue.js";
import {
  sendGmailEmail,
  type GmailApiResponse,
  GmailSendOutcomeUnknownError,
} from "../services/gmail-api.service.js";
import {
  GmailAuthorizationError,
  validateGmailTokenEncryptionKey,
} from "../services/gmail-auth.service.js";
import { acquireSenderCapacity } from "../services/rate-limiter.service.js";
import { sendSlackRateLimitNotification } from "../services/slack.service.js";
import { indexSentEmail } from "../services/email-search.service.js";

const connection = createRedisConnection();

type EmailJobData = {
  emailId: string;
};

type ClaimedEmail = {
  id: string;
  campaign_id: string;
  lead_id: string;
  recipient_email: string;
  subject: string;
  body: string;
  attempt_count: number;
  sender_email: string | null;
  gmail_email: string | null;
  gmail_send_attempted_at: Date | null;
  gmail_message_id: string | null;
  user_id: string;
};

function workerConcurrency(name: string, defaultValue: number, maxValue: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured)
    ? Math.min(maxValue, Math.max(1, Math.floor(configured)))
    : defaultValue;
}

async function updateCampaignStatus(client: PoolClient, campaignId: string) {
  await client.query(
    `UPDATE campaigns c
     SET status = CASE
       WHEN EXISTS (
         SELECT 1 FROM scheduled_emails se
         WHERE se.campaign_id = c.id
           AND se.status IN ('pending', 'queued', 'processing')
       ) THEN 'processing'
       WHEN EXISTS (
         SELECT 1 FROM scheduled_emails se
         WHERE se.campaign_id = c.id AND se.status = 'failed'
       ) THEN 'failed'
       ELSE 'completed'
     END,
     updated_at = NOW()
     WHERE c.id = $1`,
    [campaignId]
  );
}

async function startWorker() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required by the email worker");
  }
  validateGmailTokenEncryptionKey();

  const worker = new Worker<EmailJobData>(
    "email-sending",
    async (job, token) => {
      const { emailId } = job.data;
      const claim = await pool.query<ClaimedEmail>(
        `UPDATE scheduled_emails se
         SET status = 'processing',
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         FROM campaigns c
         LEFT JOIN gmail_authorizations ga ON ga.user_id = c.user_id
         LEFT JOIN users u ON u.id = c.user_id
         WHERE se.id = $1
           AND c.id = se.campaign_id
           AND se.status IN ('pending', 'queued')
         RETURNING
           se.id, se.campaign_id, se.lead_id, se.recipient_email,
           se.subject, se.body, se.attempt_count,
           se.gmail_send_attempted_at, se.gmail_message_id,
           COALESCE(ga.gmail_email, u.email) AS sender_email,
           ga.gmail_email, c.user_id`,
        [emailId]
      );
      const email = claim.rows[0];
      if (!email) return { skipped: true };

      const senderId = `gmail:${email.user_id}`;
      let capacity;
      try {
        capacity = await acquireSenderCapacity(senderId, {
          userId: email.user_id,
          emailAccountId: null,
          senderEmail: email.gmail_email ?? email.sender_email ?? "",
        });
      } catch {
        await pool.query(
          `UPDATE scheduled_emails
           SET status = 'queued',
               attempt_count = GREATEST(attempt_count - 1, 0),
               updated_at = NOW()
           WHERE id = $1 AND status = 'processing'`,
          [emailId]
        );
        await job.moveToDelayed(Date.now() + 5000, token);
        console.error("Email delayed because sender capacity could not be checked.");
        throw new DelayedError();
      }

      if (!capacity.acquired) {
        await pool.query(
          `UPDATE scheduled_emails
           SET status = 'queued',
               attempt_count = GREATEST(attempt_count - 1, 0),
               updated_at = NOW()
           WHERE id = $1 AND status = 'processing'`,
          [emailId]
        );
        await job.moveToDelayed(Date.now() + capacity.waitMs, token);
        throw new DelayedError();
      }

      let lead: {
        company: string | null;
        first_name: string | null;
        last_name: string | null;
      } | undefined;
      try {
        const leadResult = await pool.query<{
          company: string | null;
          first_name: string | null;
          last_name: string | null;
        }>(
          `SELECT company, first_name, last_name
           FROM leads
           WHERE id = $1`,
          [email.lead_id]
        );
        lead = leadResult.rows[0];
      } catch {
        console.error("Email metadata lookup failed; delivery will continue.");
      }

      let result: GmailApiResponse;
      try {
        result = await sendGmailEmail({
          userId: email.user_id,
          emailId: email.id,
          recipient: email.recipient_email,
          subject: email.subject,
          body: email.body,
          senderAddress: email.sender_email ?? "",
          sendAttempted: email.gmail_send_attempted_at !== null,
          existingMessageId: email.gmail_message_id,
          markSendAttempted: async () => {
            const persisted = await pool.query(
              `UPDATE scheduled_emails
               SET gmail_send_attempted_at = NOW(), updated_at = NOW()
               WHERE id = $1 AND status = 'processing'
                 AND gmail_send_attempted_at IS NULL
               RETURNING id`,
              [email.id]
            );
            return Boolean(persisted.rows[0]);
          },
          clearSendAttempt: async () => {
            await pool.query(
              `UPDATE scheduled_emails
               SET gmail_send_attempted_at = NULL, updated_at = NOW()
               WHERE id = $1 AND status = 'processing'`,
              [email.id]
            );
          },
        });
      } catch (error) {
        const authorizationError = error instanceof GmailAuthorizationError;
        const uncertainSend = error instanceof GmailSendOutcomeUnknownError;
        try {
          await pool.query(
            `UPDATE scheduled_emails
             SET status = 'queued',
                 last_error = $2,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'processing'`,
            [
              emailId,
              authorizationError
                ? "Gmail authorization required; reconnect Gmail in Settings"
                : uncertainSend
                  ? "Gmail send outcome is unknown; verify the message before retrying"
                : "Gmail API send failed",
            ]
          );
          await pool.query(
            `INSERT INTO email_logs
             (scheduled_email_id, event_type, attempt_number, message)
             VALUES ($1, 'retry', $2, $3)`,
            [
              emailId,
              email.attempt_count,
              authorizationError
                ? "Gmail authorization required; reconnect Gmail in Settings"
                : uncertainSend
                  ? "Gmail send outcome unknown; automatic retries will not send again"
                  : "Gmail API send failed; BullMQ will retry",
            ]
          );
        } catch (databaseError) {
          console.error("Could not update email retry status:", databaseError);
        }
        if (authorizationError) {
          throw new Error(error.message);
        }
        if (uncertainSend) throw new Error(error.message);
        console.error("Gmail API send attempt failed:", emailId);
        throw new Error("Gmail API send failed");
      }

      let sentAt: Date | string = new Date();
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        const updateResult = await client.query(
          `UPDATE scheduled_emails
           SET status = 'sent', sent_at = NOW(), last_error = NULL,
               gmail_message_id = $2, gmail_api_response = $3, updated_at = NOW()
           WHERE id = $1 AND status = 'processing'
           RETURNING sent_at`,
          [emailId, result.id, JSON.stringify(result)]
        );
        if (!updateResult.rows[0]) {
          throw new Error("Could not persist sent status");
        }
        sentAt = updateResult.rows[0].sent_at;
        await client.query(
          `INSERT INTO email_logs
           (scheduled_email_id, event_type, attempt_number, message, metadata)
           VALUES ($1, 'sent', $2, 'Gmail API accepted the message', $3)`,
          [
            emailId,
            email.attempt_count,
            JSON.stringify({
              gmailMessageId: result.id,
              gmailApiResponse: result,
            }),
          ]
        );
        await updateCampaignStatus(client, email.campaign_id);
        await client.query("COMMIT");
      } catch (databaseError) {
        if (client) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            console.error("Database rollback failed:", rollbackError);
          }
        }
        console.error(
          "Gmail accepted an email, but PostgreSQL could not confirm its sent status:",
          emailId,
          databaseError
        );
        return { ...result, persistencePending: true };
      } finally {
        client?.release();
      }

      try {
        await indexSentEmail({
          emailId: email.id,
          campaignId: email.campaign_id,
          recipientEmail: email.recipient_email,
          subject: email.subject,
          body: email.body,
          senderId,
          status: "sent",
          sentAt: new Date(sentAt).toISOString(),
          company: lead?.company ?? null,
          firstName: lead?.first_name ?? null,
          lastName: lead?.last_name ?? null,
        });
      } catch (indexError) {
        console.error("Email sent, but Elasticsearch indexing failed:", email.id, indexError);
      }
      console.log("Gmail API accepted email:", email.id);
      return result;
    },
    {
      connection,
      concurrency: workerConcurrency("WORKER_CONCURRENCY", 2, 50),
    }
  );

  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on("failed", async (job) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    console.error(`Email job ${job.id} exhausted its retry policy.`);
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const failureUpdate = await client.query<{ campaign_id: string }>(
        `UPDATE scheduled_emails
         SET status = 'failed', last_error = 'Email delivery failed after retries',
             updated_at = NOW()
         WHERE id = $1 AND status <> 'sent'
         RETURNING campaign_id`,
        [job.data.emailId]
      );
      const failedEmail = failureUpdate.rows[0];
      if (failedEmail) {
        await client.query(
          `INSERT INTO email_logs
           (scheduled_email_id, event_type, attempt_number, message)
           VALUES ($1, 'failed', $2, 'Email delivery failed after retries')`,
          [job.data.emailId, job.attemptsMade]
        );
        await updateCampaignStatus(client, failedEmail.campaign_id);
      }
      await client.query("COMMIT");
    } catch (databaseError) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Database rollback failed:", rollbackError);
        }
      }
      console.error("Failed to persist permanent email failure:", databaseError);
    } finally {
      client?.release();
    }
  });
  worker.on("error", (error) => console.error("Email worker error:", error));

  const slackWorker = new Worker<SlackNotificationData>(
    "slack-notifications",
    async (job) => {
      const result = await sendSlackRateLimitNotification(job.data);
      return result === "not-connected"
        ? { skipped: true, reason: "not-connected" }
        : { sent: true };
    },
    {
      connection,
      concurrency: workerConcurrency("SLACK_WORKER_CONCURRENCY", 2, 10),
    }
  );
  slackWorker.on("completed", (job, result) => {
    if (result && typeof result === "object" && "skipped" in result) {
      console.log(`Slack notification skipped for ${job.id}: no active connection`);
    } else {
      console.log(`Slack rate-limit notification sent for ${job.id}`);
    }
  });
  slackWorker.on("failed", (job) => {
    console.error(`Slack notification ${job?.id ?? "unknown"} exhausted its retry policy.`);
  });
  slackWorker.on("error", () => {
    console.error("Slack notification worker error.");
  });

  console.log("Email worker is running");
  console.log("Slack notification worker is running");
}

startWorker().catch((error: unknown) => {
  console.error(
    "Worker startup failed:",
    error instanceof Error ? error.message : "Unknown startup error"
  );
  process.exitCode = 1;
});
