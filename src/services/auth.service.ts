import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { pool } from "../config/database.js";
import type { AuthenticatedUser } from "../types/express-session.js";

export type GoogleProfile = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
};

let client: OAuth2Client | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateAuthEnvironment(): void {
  requiredEnv("GOOGLE_CLIENT_ID");
  requiredEnv("GOOGLE_CLIENT_SECRET");
  const callbackUrl = new URL(requiredEnv("GOOGLE_CALLBACK_URL"));
  const frontendUrl = new URL(requiredEnv("FRONTEND_URL"));
  if (process.env.NODE_ENV === "production") {
    if (callbackUrl.protocol !== "https:" || frontendUrl.protocol !== "https:") {
      throw new Error("Google callback and frontend URLs must use HTTPS in production");
    }
  }
  const secret = requiredEnv("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
}

function googleClient(): OAuth2Client {
  if (!client) {
    client = new OAuth2Client(
      requiredEnv("GOOGLE_CLIENT_ID"),
      requiredEnv("GOOGLE_CLIENT_SECRET"),
      requiredEnv("GOOGLE_CALLBACK_URL")
    );
  }
  return client;
}

export function createGoogleAuthorizationUrl(state: string): string {
  return googleClient().generateAuthUrl({
    access_type: "online",
    response_type: "code",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

export async function verifyGoogleAuthorizationCode(
  code: string
): Promise<GoogleProfile> {
  const oauthClient = googleClient();
  const { tokens } = await oauthClient.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return an ID token");

  const ticket = await oauthClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: requiredEnv("GOOGLE_CLIENT_ID"),
  });
  const payload = ticket.getPayload();
  const email = payload?.email?.trim();
  if (
    !payload?.sub ||
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    payload.email_verified !== true
  ) {
    throw new Error("Google account must have a verified email address");
  }

  return {
    sub: payload.sub,
    email,
    email_verified: true,
    ...(payload.name ? { name: payload.name } : {}),
    ...(payload.picture ? { picture: payload.picture } : {}),
  };
}

export async function findOrCreateGoogleUser(
  profile: GoogleProfile
): Promise<AuthenticatedUser> {
  if (!profile.email_verified) {
    throw new Error("Google account must have a verified email address");
  }
  const email = profile.email.trim().toLowerCase();
  if (!profile.sub.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Google returned an invalid account identity");
  }
  const name = profile.name?.trim().slice(0, 150) || null;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);

    const bySubject = await client.query<{
      id: string;
      name: string;
      email: string;
      avatar_url: string | null;
    }>(
      `SELECT id, name, email, avatar_url
       FROM users
       WHERE google_sub = $1 OR (google_sub IS NULL AND google_id = $1)
       FOR UPDATE`,
      [profile.sub]
    );

    if (bySubject.rows.length > 1) {
      throw new Error("Google identity is linked to multiple user records");
    }

    let user = bySubject.rows[0];
    if (user) {
      const conflictingEmail = await client.query(
        `SELECT id FROM users
         WHERE lower(email) = $1 AND id <> $2`,
        [email, user.id]
      );
      if (conflictingEmail.rowCount) {
        throw new Error("Google email address is already associated with another account");
      }

      const updated = await client.query<{
        id: string;
        name: string;
        email: string;
        avatar_url: string | null;
      }>(
        `UPDATE users
         SET google_sub = $1, google_id = $1, email = $2,
             name = COALESCE($3, name), avatar_url = COALESCE($4, avatar_url),
             picture = COALESCE($4, picture), updated_at = NOW()
         WHERE id = $5
         RETURNING id, name, email, avatar_url`,
        [profile.sub, email, name, profile.picture ?? null, user.id]
      );
      user = updated.rows[0];
    } else {
      const byEmail = await client.query<{
        id: string;
        name: string;
        email: string;
        avatar_url: string | null;
        google_sub: string | null;
        google_id: string | null;
      }>(
        `SELECT id, name, email, avatar_url, google_sub, google_id
         FROM users
         WHERE lower(email) = $1
         FOR UPDATE`,
        [email]
      );

      if (byEmail.rows.length > 1) {
        throw new Error("Email address matches multiple user records; contact support");
      }

      const existing = byEmail.rows[0];
      if (existing) {
        const linkedSubject = existing.google_sub ?? existing.google_id;
        if (linkedSubject && linkedSubject !== profile.sub) {
          throw new Error("This account is already linked to a different Google identity");
        }

        const updated = await client.query<{
          id: string;
          name: string;
          email: string;
          avatar_url: string | null;
        }>(
          `UPDATE users
           SET google_sub = $1, google_id = $1, email = $2,
               name = COALESCE($3, name), avatar_url = COALESCE($4, avatar_url),
               picture = COALESCE($4, picture), updated_at = NOW()
           WHERE id = $5
           RETURNING id, name, email, avatar_url`,
          [profile.sub, email, name, profile.picture ?? null, existing.id]
        );
        user = updated.rows[0];
      } else {
        const created = await client.query<{
          id: string;
          name: string;
          email: string;
          avatar_url: string | null;
        }>(
          `INSERT INTO users
             (id, google_sub, google_id, name, email, avatar_url, picture)
           VALUES ($1, $2, $2, $3, $4, $5, $5)
           RETURNING id, name, email, avatar_url`,
          [randomUUID(), profile.sub, name ?? email.slice(0, 150), email, profile.picture ?? null]
        );
        user = created.rows[0];
      }
    }

    if (!user) throw new Error("Unable to create or locate the authenticated user");
    await client.query("COMMIT");
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatar_url,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
