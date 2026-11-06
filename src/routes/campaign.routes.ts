import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/database.js";

const router = Router();

const campaignSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  scheduledAt: z.string().datetime().optional(),
  timezone: z.string().default("UTC"),
  minimumDelaySeconds: z.number().int().min(0).default(2),
});

router.post("/", async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid campaign data",
      details: parsed.error.flatten(),
    });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  const data = parsed.data;

  const result = await pool.query(
    `INSERT INTO campaigns
      (user_id, name, subject, body, scheduled_at, timezone, minimum_delay_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      userId,
      data.name,
      data.subject,
      data.body,
      data.scheduledAt ?? null,
      data.timezone,
      data.minimumDelaySeconds,
    ]
  );

  return res.status(201).json({
    message: "Campaign created successfully",
    campaign: result.rows[0],
  });
});

router.get("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const result = await pool.query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM scheduled_emails se
        WHERE se.campaign_id = c.id) AS total_emails
     FROM campaigns c
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC`,
    [userId]
  );

  return res.json({ campaigns: result.rows });
});

router.get("/:id", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const result = await pool.query(
    `SELECT * FROM campaigns
     WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Campaign not found" });
  }

  return res.json({ campaign: result.rows[0] });
});

router.get("/:id/emails", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const result = await pool.query(
    `SELECT se.*
     FROM scheduled_emails se
     JOIN campaigns c ON c.id = se.campaign_id
     WHERE c.id = $1 AND c.user_id = $2
     ORDER BY se.created_at DESC`,
    [req.params.id, userId]
  );

  return res.json({ emails: result.rows });
});

export default router;