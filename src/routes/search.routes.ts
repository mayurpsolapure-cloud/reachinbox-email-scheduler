
import { Router } from "express";
import {
  searchSentEmails,
} from "../services/email-search.service.js";

const router = Router();

// GET /api/search/emails?q=alice
router.get("/search/emails", async (req, res) => {
  const query =
    typeof req.query.q === "string"
      ? req.query.q.trim()
      : "";

  if (!query) {
    return res.status(400).json({
      error: "Search query parameter q is required",
    });
  }

  if (query.length > 200) {
    return res.status(400).json({
      error: "Search query must not exceed 200 characters",
    });
  }

  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const emails = await searchSentEmails(query, userId);

    return res.status(200).json({
      query,
      count: emails.length,
      emails,
    });
  } catch (error) {
    console.error("Email search failed:", error);

    return res.status(503).json({
      error: "Email search is temporarily unavailable",
    });
  }
});

export default router;
