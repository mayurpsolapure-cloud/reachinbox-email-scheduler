import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import { createAuthRouter } from "../src/routes/auth.routes.js";
import type { GoogleProfile } from "../src/routes/auth.routes.js";
import { createGoogleAuthorizationUrl } from "../src/services/auth.service.js";
import { requireAuth } from "../src/middleware/require-auth.js";
import type { AuthenticatedUser } from "../src/types/express-session.js";

process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_CALLBACK_URL = "http://localhost:5000/api/auth/google/callback";
process.env.GOOGLE_GMAIL_CALLBACK_URL = "http://localhost:5000/api/integrations/gmail/callback";
process.env.FRONTEND_URL = "http://localhost:5173";

const profile: GoogleProfile = {
  profile: {
    sub: "google-subject-123",
    email: "person@example.com",
    email_verified: true,
    name: "Test Person",
    picture: "https://example.com/avatar.png",
  },
  refreshToken: null,
  scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send"],
};
const testUser: AuthenticatedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test Person",
  email: profile.profile.email,
  avatarUrl: "https://example.com/avatar.png",
};

let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";
let verifyCode: (code: string) => Promise<GoogleProfile> = async () => profile;
let findOrCreateCalls = 0;

before(async () => {
  const app = express();
  app.use(session({
    name: "reachinbox.sid",
    secret: "test-session-secret-with-at-least-thirty-two-characters",
    resave: false,
    saveUninitialized: false,
  }));
  app.use("/api/auth", createAuthRouter({
    createAuthorizationUrl: createGoogleAuthorizationUrl,
    verifyCode: (code) => verifyCode(code),
    findOrCreateUser: async () => {
      findOrCreateCalls += 1;
      return testUser;
    },
    saveGmailAuthorization: async () => {},
  }));
  app.get("/api/protected", requireAuth, (req, res) => {
    res.json({ userId: req.user?.id });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

async function beginGoogleLogin() {
  const response = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { location, cookie };
}

test("unauthenticated /api/auth/me returns 401", async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(response.status, 401);
});

test("Google login redirects with requested OpenID scopes and CSRF state", async () => {
  const { location } = await beginGoogleLogin();
  assert.equal(location.hostname, "accounts.google.com");
  assert.match(location.searchParams.get("scope") ?? "", /openid/);
  assert.match(location.searchParams.get("scope") ?? "", /email/);
  assert.match(location.searchParams.get("scope") ?? "", /profile/);
  assert.match(location.searchParams.get("scope") ?? "", /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.equal(location.searchParams.get("state")?.length, 43);
});

test("Gmail reconnect requests offline Gmail sending consent on its own callback", () => {
  const location = new URL(createGoogleAuthorizationUrl("gmail-state", "gmail"));
  assert.equal(location.searchParams.get("redirect_uri"), process.env.GOOGLE_GMAIL_CALLBACK_URL);
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.match(location.searchParams.get("prompt") ?? "", /consent/);
  assert.match(location.searchParams.get("scope") ?? "", /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
});

test("callback rejects invalid state", async () => {
  const { cookie } = await beginGoogleLogin();
  const response = await fetch(
    `${baseUrl}/api/auth/google/callback?code=valid&state=incorrect`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location") ?? "").searchParams.get("authError"), "invalid_state");
});

test("callback rejects a failed Google token exchange", async () => {
  verifyCode = async () => { throw new Error("invalid ID token"); };
  const { cookie, location } = await beginGoogleLogin();
  const response = await fetch(
    `${baseUrl}/api/auth/google/callback?code=bad-token&state=${location.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location") ?? "").searchParams.get("authError"), "google_auth_failed");
  verifyCode = async () => profile;
});

test("callback rejects unverified Google email", async () => {
  verifyCode = async () => ({
    ...profile,
    profile: { ...profile.profile, email_verified: false },
  });
  const { cookie, location } = await beginGoogleLogin();
  const response = await fetch(
    `${baseUrl}/api/auth/google/callback?code=unverified&state=${location.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location") ?? "").searchParams.get("authError"), "google_auth_failed");
  assert.equal(findOrCreateCalls, 0);
  verifyCode = async () => profile;
});

test("verified callback persists the authenticated profile in a new session", async () => {
  const { cookie, location } = await beginGoogleLogin();
  const response = await fetch(
    `${baseUrl}/api/auth/google/callback?code=verified&state=${location.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost:5173/scheduled");
  const newCookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(newCookie);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: newCookie } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, testUser);
  const protectedResponse = await fetch(`${baseUrl}/api/protected`, { headers: { cookie: newCookie } });
  assert.equal(protectedResponse.status, 200);
  assert.equal((await protectedResponse.json()).userId, testUser.id);
});

test("logout destroys the session and clears authentication", async () => {
  const { cookie, location } = await beginGoogleLogin();
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?code=verified&state=${location.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" }
  );
  const authenticatedCookie = callback.headers.get("set-cookie")?.split(";")[0];
  assert.ok(authenticatedCookie);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(logout.status, 204);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: authenticatedCookie } });
  assert.equal(me.status, 401);
});

test("protected APIs require an authenticated session", async () => {
  const response = await fetch(`${baseUrl}/api/protected`);
  assert.equal(response.status, 401);
});
