import { DelayedError, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { PoolClient } from "pg";
import { pool } from "../config/database.js";
import {
  slackNotificationQueue,
  type SlackNotificationData,
} from "../queue/email.queue.js";
import {
  getSenderEmail,
  initializeEmailService,
  sendTestEmail,
} from "../services/email.service.js";
import { acquireSenderCapacity } from "../services/rate-limiter.service.js";
import { sendSlackRateLimitNotification } from "../services/slack.service.js";
import { indexSentEmail } from "../services/email-search.service.js";

const connection = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

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
  email_account_id: string | null;
  sender_email: string | null;
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
  await initializeEmailService();

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
         LEFT JOIN email_accounts ea ON ea.id = c.email_account_id
         WHERE se.id = $1
           AND c.id = se.campaign_id
           AND se.status IN ('pending', 'queued')
         RETURNING
           se.id, se.campaign_id, se.lead_id, se.recipient_email,
           se.subject, se.body, se.attempt_count,
           COALESCE(se.email_account_id, c.email_account_id) AS email_account_id,
           ea.email AS sender_email, c.user_id`,
        [emailId]
      );
      const email = claim.rows[0];
      if (!email) return { skipped: true };

      const senderId = email.email_account_id ?? "default-ethereal-sender";
      let capacity;
      try {
        capacity = await acquireSenderCapacity(senderId, {
          userId: email.user_id,
          emailAccountId: email.email_account_id,
          senderEmail: email.sender_email ?? getSenderEmail(),
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

      let result: Awaited<ReturnType<typeof sendTestEmail>>;
      try {
        result = await sendTestEmail(email.recipient_email, email.subject, email.body);
      } catch {
        try {
          await pool.query(
            `UPDATE scheduled_emails
             SET status = 'queued',
                 last_error = 'SMTP send failed',
                 updated_at = NOW()
             WHERE id = $1 AND status = 'processing'`,
            [emailId]
          );
          await pool.query(
            `INSERT INTO email_logs
             (scheduled_email_id, event_type, attempt_number, message)
             VALUES ($1, 'retry', $2, 'SMTP send failed')`,
            [emailId, email.attempt_count]
          );
        } catch (databaseError) {
          console.error("Could not update email retry status:", databaseError);
        }
        throw new Error("SMTP send failed");
      }

      let sentAt: Date | string = new Date();
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        const updateResult = await client.query(
          `UPDATE scheduled_emails
           SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'processing'
           RETURNING sent_at`,
          [emailId]
        );
        if (!updateResult.rows[0]) {
          throw new Error("Could not persist sent status");
        }
        sentAt = updateResult.rows[0].sent_at;
        await client.query(
          `INSERT INTO email_logs
           (scheduled_email_id, event_type, attempt_number, message, metadata)
           VALUES ($1, 'sent', $2, 'Email sent successfully', $3)`,
          [
            emailId,
            email.attempt_count,
            JSON.stringify({
              messageId: result.messageId,
              previewUrl: result.previewUrl,
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
          "SMTP accepted an email, but PostgreSQL could not confirm its sent status:",
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
      console.log("Email sent:", email.recipient_email);
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

startWorker().catch(() => {
  console.error("Worker startup failed.");
  process.exitCode = 1;
});
