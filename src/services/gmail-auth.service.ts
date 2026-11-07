import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pool } from "../config/database.js";
import type { GoogleProfile } from "./auth.service.js";

const TOKEN_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type GmailAuthorizationStatus = {
  connected: boolean;
  email: string | null;
  status: "connected" | "reauthorization_required" | "not_connected";
  reason?: "missing_refresh_token" | "revoked_or_expired";
};

export type GmailAuthorization = {
  userId: string;
  email: string;
  googleSub: string;
  refreshToken: string;
};

export class GmailAuthorizationError extends Error {
  constructor(
    message: string,
    readonly reason: "missing_refresh_token" | "revoked_or_expired" = "missing_refresh_token"
  ) {
    super(message);
    this.name = "GmailAuthorizationError";
  }
}

function encryptionKey(): Buffer {
  const value = process.env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters");
  }
  return Buffer.from(value, "hex");
}

export function validateGmailTokenEncryptionKey(): void {
  encryptionKey();
}

export function encryptGmailRefreshToken(token: string): {
  ciphertext: string;
  nonce: string;
  tag: string;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(TOKEN_ENCRYPTION_ALGORITHM, encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptGmailRefreshToken(value: {
  ciphertext: string;
  nonce: string;
  tag: string;
}): string {
  const decipher = createDecipheriv(
    TOKEN_ENCRYPTION_ALGORITHM,
    encryptionKey(),
    Buffer.from(value.nonce, "hex")
  );
  decipher.setAuthTag(Buffer.from(value.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function saveGmailAuthorization(
  userId: string,
  profile: GoogleProfile,
  refreshToken: string | null,
  scopes: string[],
  options: { requireFreshRefreshToken?: boolean } = {}
): Promise<void> {
  if (!profile.email_verified || !scopes.includes(REQUIRED_SCOPE)) {
    throw new Error("Google did not grant the required Gmail sending permission");
  }

  const userResult = await pool.query<{ email: string; google_sub: string | null }>(
    "SELECT email, google_sub FROM users WHERE id = $1",
    [userId]
  );
  const user = userResult.rows[0];
  if (
    !user ||
    user.google_sub !== profile.sub ||
    user.email.toLowerCase() !== profile.email.toLowerCase()
  ) {
    throw new Error("Gmail authorization account does not match the signed-in Google account");
  }

  const existingResult = await pool.query<{
    google_sub: string;
    refresh_token_ciphertext: string | null;
    refresh_token_nonce: string | null;
    refresh_token_tag: string | null;
    status: "connected" | "reauthorization_required";
  }>(
    `SELECT google_sub, refresh_token_ciphertext, refresh_token_nonce,
            refresh_token_tag, status
     FROM gmail_authorizations
     WHERE user_id = $1`,
    [userId]
  );
  const existing = existingResult.rows[0];
  if (existing && existing.google_sub !== profile.sub) {
    throw new Error("Gmail authorization belongs to a different Google account");
  }

  if (
    !refreshToken &&
    !options.requireFreshRefreshToken &&
    existing?.status === "connected" &&
    existing.refresh_token_ciphertext
  ) {
    await pool.query(
      `UPDATE gmail_authorizations
       SET gmail_email = $2, granted_scopes = $3, status = 'connected',
           last_error_code = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, profile.email.toLowerCase(), scopes]
    );
    return;
  }

  if (!refreshToken) {
    await pool.query(
      `INSERT INTO gmail_authorizations
         (user_id, gmail_email, google_sub, granted_scopes, status,
          last_error_code, authorized_at)
       VALUES ($1, $2, $3, $4, 'reauthorization_required',
               'missing_refresh_token', NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET gmail_email = EXCLUDED.gmail_email,
           google_sub = EXCLUDED.google_sub,
           granted_scopes = EXCLUDED.granted_scopes,
           status = 'reauthorization_required',
           last_error_code = 'missing_refresh_token',
           updated_at = NOW()`,
      [userId, profile.email.toLowerCase(), profile.sub, scopes]
    );
    return;
  }

  const encrypted = encryptGmailRefreshToken(refreshToken);
  await pool.query(
    `INSERT INTO gmail_authorizations
       (user_id, gmail_email, google_sub, refresh_token_ciphertext,
        refresh_token_nonce, refresh_token_tag, granted_scopes, status,
        last_error_code, authorized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', NULL, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET gmail_email = EXCLUDED.gmail_email,
         google_sub = EXCLUDED.google_sub,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         refresh_token_nonce = EXCLUDED.refresh_token_nonce,
         refresh_token_tag = EXCLUDED.refresh_token_tag,
         granted_scopes = EXCLUDED.granted_scopes,
         status = 'connected',
         last_error_code = NULL,
         authorized_at = NOW(),
         updated_at = NOW()`,
    [
      userId,
      profile.email.toLowerCase(),
      profile.sub,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
      scopes,
    ]
  );
}

export async function getGmailAuthorizationStatus(
  userId: string
): Promise<GmailAuthorizationStatus> {
  const result = await pool.query<{
    gmail_email: string;
    status: "connected" | "reauthorization_required";
    last_error_code: string | null;
  }>(
    `SELECT gmail_email, status, last_error_code
     FROM gmail_authorizations
     WHERE user_id = $1`,
    [userId]
  );
  const authorization = result.rows[0];
  if (!authorization) {
    return { connected: false, email: null, status: "not_connected" };
  }
  const reason = authorization.last_error_code === "revoked_or_expired"
    ? "revoked_or_expired"
    : authorization.last_error_code === "missing_refresh_token"
      ? "missing_refresh_token"
      : undefined;
  return {
    connected: authorization.status === "connected",
    email: authorization.gmail_email,
    status: authorization.status,
    ...(reason ? { reason } : {}),
  };
}

export async function loadGmailAuthorization(userId: string): Promise<GmailAuthorization> {
  const result = await pool.query<{
    gmail_email: string;
    google_sub: string;
    refresh_token_ciphertext: string | null;
    refresh_token_nonce: string | null;
    refresh_token_tag: string | null;
    status: "connected" | "reauthorization_required";
  }>(
    `SELECT gmail_email, google_sub, refresh_token_ciphertext,
            refresh_token_nonce, refresh_token_tag, status
     FROM gmail_authorizations
     WHERE user_id = $1`,
    [userId]
  );
  const authorization = result.rows[0];
  if (
    !authorization ||
    authorization.status !== "connected" ||
    !authorization.refresh_token_ciphertext ||
    !authorization.refresh_token_nonce ||
    !authorization.refresh_token_tag
  ) {
    throw new GmailAuthorizationError(
      "Connect or reconnect Gmail before sending scheduled emails.",
      authorization?.status === "reauthorization_required"
        ? "revoked_or_expired"
        : "missing_refresh_token"
    );
  }
  return {
    userId,
    email: authorization.gmail_email,
    googleSub: authorization.google_sub,
    refreshToken: decryptGmailRefreshToken({
      ciphertext: authorization.refresh_token_ciphertext,
      nonce: authorization.refresh_token_nonce,
      tag: authorization.refresh_token_tag,
    }),
  };
}

export async function requireGmailReauthorization(userId: string): Promise<void> {
  await pool.query(
    `UPDATE gmail_authorizations
     SET status = 'reauthorization_required',
         last_error_code = 'revoked_or_expired',
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}
