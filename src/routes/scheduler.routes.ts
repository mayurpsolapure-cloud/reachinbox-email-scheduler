import { Router } from "express";
import { pool } from "../config/database.js";
import { emailQueue } from "../queue/email.queue.js";

const router = Router();

router.post("/campaigns/:id/schedule", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  const campaignId = req.params.id;

  const campaignResult = await pool.query(
    `SELECT id, minimum_delay_seconds
     FROM campaigns
     WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );

  if (campaignResult.rowCount === 0) {
    return res.status(404).json({ error: "Campaign not found" });
  }

  const campaign = campaignResult.rows[0];

  const pendingCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM scheduled_emails
     WHERE campaign_id = $1 AND status = 'pending'`,
    [campaignId]
  );
  const totalPending = Number(pendingCount.rows[0]?.count ?? 0);

  if (totalPending === 0) {
    return res.status(400).json({
      error: "No pending emails found for this campaign",
    });
  }

  let queued = 0;
  let processed = 0;
  let cursor: { scheduled_for: Date; created_at: Date; id: string } | undefined;
  const batchSize = 100;

  while (processed < totalPending) {
    const batch = cursor
      ? await pool.query<{
          id: string;
          scheduled_for: Date;
          created_at: Date;
        }>(
          `SELECT id, scheduled_for, created_at
           FROM scheduled_emails
           WHERE campaign_id = $1 AND status = 'pending'
             AND (scheduled_for, created_at, id) > ($2, $3, $4)
           ORDER BY scheduled_for, created_at, id
           LIMIT $5`,
          [campaignId, cursor.scheduled_for, cursor.created_at, cursor.id, batchSize]
        )
      : await pool.query<{
          id: string;
          scheduled_for: Date;
          created_at: Date;
        }>(
          `SELECT id, scheduled_for, created_at
           FROM scheduled_emails
           WHERE campaign_id = $1 AND status = 'pending'
           ORDER BY scheduled_for, created_at, id
           LIMIT $2`,
          [campaignId, batchSize]
        );

    if (batch.rows.length === 0) break;
    const baseIndex = processed;
    const jobs = batch.rows.map((email, index) => {
      const jobId = `email-${email.id}`;
      const scheduledTime = new Date(email.scheduled_for).getTime();
      const staggerDelay =
        (baseIndex + index) * Number(campaign.minimum_delay_seconds) * 1000;
      return {
        name: "send-email",
        data: { emailId: email.id },
        opts: {
          jobId,
          delay: Math.max(0, scheduledTime - Date.now()) + staggerDelay,
        },
      };
    });

    await emailQueue.addBulk(jobs);
    const ids = batch.rows.map((email) => email.id);
    const jobIds = ids.map((id) => `email-${id}`);
    const updated = await pool.query<{ id: string }>(
      `UPDATE scheduled_emails se
       SET status = 'queued',
           bull_job_id = batch.job_id,
           updated_at = NOW()
       FROM unnest($1::uuid[], $2::text[]) AS batch(id, job_id)
       WHERE se.id = batch.id AND se.status = 'pending'
       RETURNING se.id`,
      [ids, jobIds]
    );
    if (updated.rows.length) {
      await pool.query(
        `INSERT INTO email_logs (scheduled_email_id, event_type, message)
         SELECT batch.id, 'queued', 'Email added to BullMQ'
         FROM unnest($1::uuid[]) AS batch(id)`,
        [updated.rows.map((email) => email.id)]
      );
    }

    queued += updated.rows.length;
    processed += batch.rows.length;
    const last = batch.rows[batch.rows.length - 1];
    if (!last) break;
    cursor = {
      id: last.id,
      scheduled_for: last.scheduled_for,
      created_at: last.created_at,
    };
  }

  await pool.query(
    `UPDATE campaigns
     SET status = 'processing', updated_at = NOW()
     WHERE id = $1`,
    [campaignId]
  );

  return res.json({
    message: "Campaign scheduled successfully",
    totalPending,
    queued,
  });
});

export default router;