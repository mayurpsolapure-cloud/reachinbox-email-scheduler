import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { pool } from "../src/config/database.js";
import {
  decryptGmailRefreshToken,
  getGmailAuthorizationStatus,
  requireGmailReauthorization,
  saveGmailAuthorization,
} from "../src/services/gmail-auth.service.js";

process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("hex");

const userIds = [randomUUID(), randomUUID()];

after(async () => {
  await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await pool.end();
});

test("refresh tokens are encrypted, account-bound, and isolated per user", async () => {
  const profiles = userIds.map((id, index) => ({
    sub: `gmail-sub-${id}`,
    email: `gmail-${index}-${id}@example.invalid`,
    email_verified: true,
  }));
  const tokens = ["refresh-token-user-a", "refresh-token-user-b"];
  try {
    await pool.query(
      `INSERT INTO users (id, google_sub, name, email)
       VALUES ($1, $2, 'Gmail A', $3), ($4, $5, 'Gmail B', $6)`,
      [userIds[0], profiles[0]?.sub, profiles[0]?.email, userIds[1], profiles[1]?.sub, profiles[1]?.email]
    );
    for (let index = 0; index < userIds.length; index += 1) {
      const userId = userIds[index];
      const profile = profiles[index];
      const token = tokens[index];
      assert.ok(userId && profile && token);
      await saveGmailAuthorization(
        userId,
        profile,
        token,
        ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send"]
      );
    }

    const stored = await pool.query<{
      user_id: string;
      gmail_email: string;
      refresh_token_ciphertext: string;
      refresh_token_nonce: string;
      refresh_token_tag: string;
    }>(
      `SELECT user_id, gmail_email, refresh_token_ciphertext,
              refresh_token_nonce, refresh_token_tag
       FROM gmail_authorizations
       WHERE user_id = ANY($1::uuid[])
       ORDER BY user_id`,
      [userIds]
    );
    assert.equal(stored.rows.length, 2);
    for (const row of stored.rows) {
      const index = userIds.indexOf(row.user_id);
      const token = tokens[index];
      assert.ok(token);
      assert.notEqual(row.refresh_token_ciphertext, token);
      assert.equal(decryptGmailRefreshToken({
        ciphertext: row.refresh_token_ciphertext,
        nonce: row.refresh_token_nonce,
        tag: row.refresh_token_tag,
      }), token);
    }
    assert.deepEqual(
      await Promise.all(userIds.map((id) => getGmailAuthorizationStatus(id))),
      userIds.map((_, index) => ({
        connected: true,
        email: profiles[index]?.email,
        status: "connected",
      }))
    );
    await assert.rejects(
      saveGmailAuthorization(userIds[0]!, profiles[1]!, "wrong-user-token", [
        "https://www.googleapis.com/auth/gmail.send",
      ]),
      /does not match the signed-in Google account/
    );
    await assert.rejects(
      saveGmailAuthorization(userIds[0]!, profiles[0]!, "ungranted-token", []),
      /did not grant the required Gmail sending permission/
    );
    await saveGmailAuthorization(
      userIds[0]!,
      profiles[0]!,
      null,
      ["https://www.googleapis.com/auth/gmail.send"],
      { requireFreshRefreshToken: true }
    );
    assert.deepEqual(await getGmailAuthorizationStatus(userIds[0]!), {
      connected: false,
      email: profiles[0]?.email,
      status: "reauthorization_required",
      reason: "missing_refresh_token",
    });
    await requireGmailReauthorization(userIds[0]!);
    assert.deepEqual(await getGmailAuthorizationStatus(userIds[0]!), {
      connected: false,
      email: profiles[0]?.email,
      status: "reauthorization_required",
      reason: "revoked_or_expired",
    });
  } finally {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  }
});
