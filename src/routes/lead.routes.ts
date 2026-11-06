import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { pool } from "../config/database.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Upload a CSV file using the field name 'file'",
    });
  }

  let records: Record<string, string>[];

  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch {
    return res.status(400).json({ error: "Invalid CSV file" });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: "CSV contains no records" });
  }

  const invalidRows = records
    .map((row, index) => ({
      row: index + 2,
      email: row.email,
    }))
    .filter(
      (item) =>
        !item.email ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email)
    );

  if (invalidRows.length > 0) {
    return res.status(400).json({
      error: "Some rows have missing or invalid email addresses",
      invalidRows,
    });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  const campaignId =
    typeof req.body.campaignId === "string"
      ? req.body.campaignId
      : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let campaign: Record<string, unknown> | null = null;

    if (campaignId) {
      const campaignResult = await client.query(
        `SELECT * FROM campaigns
         WHERE id = $1 AND user_id = $2`,
        [campaignId, userId]
      );

      if (campaignResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Campaign not found" });
      }

      campaign = campaignResult.rows[0];
    }

    let imported = 0;
    let duplicates = 0;
    let scheduled = 0;

    for (const row of records) {
      const email =
        typeof row.email === "string"
          ? row.email.trim().toLowerCase()
          : "";

      const leadResult = await client.query(
        `INSERT INTO leads
          (user_id, email, first_name, last_name, company)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, email) DO NOTHING
         RETURNING id`,
        [
          userId,
          email,
          row.first_name || null,
          row.last_name || null,
          row.company || null,
        ]
      );

      let leadId: string;

      if (leadResult.rowCount === 0) {
        duplicates++;

        const existing = await client.query(
          `SELECT id FROM leads
           WHERE user_id = $1 AND email = $2`,
          [userId, email]
        );

        leadId = existing.rows[0].id as string;
      } else {
        imported++;
        leadId = leadResult.rows[0].id as string;
      }

      if (campaign) {
        const campaignData = campaign as {
          id: string;
          subject: string;
          body: string;
          scheduled_at: Date | null;
        };

        const emailResult = await client.query(
          `INSERT INTO scheduled_emails
            (campaign_id, lead_id, recipient_email, subject, body,
             scheduled_for, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (campaign_id, lead_id) DO NOTHING
           RETURNING id`,
          [
            campaignData.id,
            leadId,
            email,
            campaignData.subject,
            campaignData.body,
            campaignData.scheduled_at ?? new Date(),
            `${campaignData.id}:${leadId}`,
          ]
        );

        if (emailResult.rowCount && emailResult.rowCount > 0) {
          scheduled++;
        }
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "CSV import completed",
      totalRows: records.length,
      imported,
      duplicates,
      scheduledEmailsCreated: scheduled,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("CSV import failed:", error);

    return res.status(500).json({
      error: "Failed to import CSV",
    });
  } finally {
    client.release();
  }
});

router.get("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const result = await pool.query(
    `SELECT * FROM leads
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    "SELECT COUNT(*) FROM leads WHERE user_id = $1",
    [userId]
  );

  return res.json({
    leads: result.rows,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  });
});

export default router;