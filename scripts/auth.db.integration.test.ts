import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "../src/config/database.js";
import { findOrCreateGoogleUser } from "../src/services/auth.service.js";

test("Google user creation, email linking, and conflicting identity protection", async () => {
  const marker = randomUUID();
  const email = `oauth-${marker}@example.invalid`;
  const subject = `google-sub-${marker}`;
  const secondSubject = `google-other-${marker}`;
  const existingUserId = randomUUID();

  try {
    const first = await findOrCreateGoogleUser({
      sub: subject,
      email,
      email_verified: true,
      name: "OAuth Integration User",
      picture: "https://example.invalid/avatar.png",
    });
    const repeat = await findOrCreateGoogleUser({
      sub: subject,
      email,
      email_verified: true,
      name: "OAuth Integration User",
    });
    assert.equal(repeat.id, first.id);

    await pool.query(
      `INSERT INTO users (id, name, email)
       VALUES ($1, $2, $3)`,
      [existingUserId, "Existing Account", `linked-${email}`]
    );
    const linkedEmail = `linked-${email}`;
    const linked = await findOrCreateGoogleUser({
      sub: `google-link-${marker}`,
      email: linkedEmail,
      email_verified: true,
      name: "Linked Google User",
    });
    assert.equal(linked.id, existingUserId);
    assert.equal(linked.email, linkedEmail);

    await assert.rejects(
      findOrCreateGoogleUser({
        sub: secondSubject,
        email,
        email_verified: true,
      }),
      /different Google identity/
    );

    const stored = await pool.query<{
      google_sub: string;
      avatar_url: string | null;
    }>(
      "SELECT google_sub, avatar_url FROM users WHERE id = $1",
      [first.id]
    );
    assert.equal(stored.rows[0]?.google_sub, subject);
    assert.equal(stored.rows[0]?.avatar_url, "https://example.invalid/avatar.png");
  } finally {
    await pool.query(
      `DELETE FROM users
       WHERE email = $1 OR email = $2 OR google_sub = ANY($3::text[])`,
      [email, `linked-${email}`, [subject, secondSubject, `google-link-${marker}`]]
    );
    await pool.end();
  }
});
