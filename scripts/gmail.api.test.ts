import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import { createGmailIntegrationRouter } from "../src/routes/gmail-integration.routes.js";
import { requireAuth } from "../src/middleware/require-auth.js";
import {
  decryptGmailRefreshToken,
  encryptGmailRefreshToken,
} from "../src/services/gmail-auth.service.js";
import {
  createGmailApiAdapter,
  createGmailEmailService,
  createMimeMessage,
  refreshGmailAccessToken,
  GmailSendOutcomeUnknownError,
  type GmailClient,
  type GmailServiceDependencies,
} from "../src/services/gmail-api.service.js";

process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("hex");
process.env.FRONTEND_URL = "http://localhost:5173";

const userId = "00000000-0000-4000-8000-000000000001";
const refreshToken = "mock-refresh-token";
const authorization = {
  userId,
  email: "sender@example.com",
  googleSub: "google-sub-1",
  refreshToken,
};

function createMockClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    getAuthenticatedIdentity: async () => ({
      email: authorization.email,
      googleSub: authorization.googleSub,
    }),
    sendMessage: async () => ({ id: "gmail-message-1", threadId: "thread-1" }),
    ...overrides,
  };
}

function createDependencies(
  client: GmailClient,
  options: Partial<GmailServiceDependencies> = {}
): GmailServiceDependencies {
  return {
    loadAuthorization: async (targetUserId) => ({
      ...authorization,
      userId: targetUserId,
    }),
    markReauthorizationRequired: async () => {},
    createClient: async () => client,
    ...options,
  };
}

function sendInput(overrides: Partial<Parameters<ReturnType<typeof createGmailEmailService>>[0]> = {}) {
  return {
    userId,
    emailId: "email-1",
    recipient: "recipient@example.net",
    subject: "Hello",
    body: "Plain <body>\nSecond line",
    senderAddress: "sender@example.com",
    existingMessageId: null,
    sendAttempted: false,
    markSendAttempted: async () => true,
    clearSendAttempt: async () => {},
    ...overrides,
  };
}

test("refresh-token encryption uses authenticated AES-256-GCM ciphertext", () => {
  const encrypted = encryptGmailRefreshToken(refreshToken);
  assert.notEqual(encrypted.ciphertext, refreshToken);
  assert.equal(decryptGmailRefreshToken(encrypted), refreshToken);
  assert.throws(() => decryptGmailRefreshToken({ ...encrypted, tag: "00".repeat(16) }));
});

test("MIME message includes the matching sender, recipient and plain/HTML alternatives", () => {
  const raw = createMimeMessage({
    emailId: "email-1",
    from: "sender@example.com",
    recipient: "recipient@example.net",
    subject: "Hello",
    body: "Plain <body>\nSecond line",
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /From: sender@example\.com/);
  assert.match(mime, /To: recipient@example\.net/);
  assert.match(mime, /Content-Type: text\/plain/);
  assert.match(mime, /Content-Type: text\/html/);
  const htmlPart = mime.split("Content-Type: text/html")[1]?.split("\r\n\r\n")[1]?.split("\r\n--")[0];
  assert.ok(htmlPart);
  assert.equal(
    Buffer.from(htmlPart, "base64").toString("utf8"),
    "<div>Plain &lt;body&gt;<br>Second line</div>"
  );
  assert.match(mime, /Message-ID: <reachinbox-email-1@reachinbox\.invalid>/);
  assert.throws(
    () => createMimeMessage({
      emailId: "email-2",
      from: "sender@example.com",
      recipient: "bad@example.net\r\nBcc: other@example.net",
      subject: "Invalid",
      body: "Body",
    }),
    /Invalid recipient header/
  );
});

test("mock Gmail send verifies the signed-in sender and persists an attempt before sending", async () => {
  let sendAttemptRecorded = false;
  let rawMessage = "";
  const client = createMockClient({
    sendMessage: async (raw) => {
      rawMessage = raw;
      return { id: "gmail-message-1" };
    },
  });
  const send = createGmailEmailService(createDependencies(client));
  const response = await send(sendInput({
    markSendAttempted: async () => {
      sendAttemptRecorded = true;
      return true;
    },
  }));
  assert.equal(sendAttemptRecorded, true);
  assert.equal(response.id, "gmail-message-1");
  assert.match(Buffer.from(rawMessage, "base64url").toString("utf8"), /From: sender@example\.com/);
});

test("sender identity mismatch blocks sending and marks Gmail reconnect required", async () => {
  let marked = false;
  const client = createMockClient({
    getAuthenticatedIdentity: async () => ({
      email: "someone-else@example.com",
      googleSub: "other-google-sub",
    }),
  });
  const send = createGmailEmailService(createDependencies(client, {
    markReauthorizationRequired: async () => { marked = true; },
  }));
  await assert.rejects(send(sendInput()), /does not match the connected account/);
  assert.equal(marked, true);
});

test("definitive Gmail rate-limit failures can safely retry", async () => {
  let sendAttempts = 0;
  const client = createMockClient({
    sendMessage: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw { response: { status: 429 } };
      }
      return { id: "gmail-message-retry" };
    },
  });
  const send = createGmailEmailService(createDependencies(client));
  let attempted = false;
  const first = sendInput({
    sendAttempted: false,
    markSendAttempted: async () => { attempted = true; return true; },
    clearSendAttempt: async () => { attempted = false; },
  });
  await assert.rejects(send(first));
  const response = await send(sendInput({
    sendAttempted: attempted,
    markSendAttempted: async () => { attempted = true; return true; },
  }));
  assert.equal(response.id, "gmail-message-retry");
  assert.equal(sendAttempts, 2);
});

test("ambiguous Gmail response never triggers a duplicate send on retry", async () => {
  let sendAttempts = 0;
  const client = createMockClient({
    sendMessage: async () => {
      sendAttempts += 1;
      throw { response: { status: 503 } };
    },
  });
  const send = createGmailEmailService(createDependencies(client));
  let attempted = false;
  await assert.rejects(send(sendInput({
    markSendAttempted: async () => { attempted = true; return true; },
  })), GmailSendOutcomeUnknownError);
  await assert.rejects(send(sendInput({
    sendAttempted: attempted,
    markSendAttempted: async () => { throw new Error("must not send again"); },
  })), GmailSendOutcomeUnknownError);
  assert.equal(sendAttempts, 1);
});

test("revoked Gmail refresh token is marked for reconnect", async () => {
  let marked = false;
  const send = createGmailEmailService(createDependencies(createMockClient(), {
    createClient: async () => {
      throw Object.assign(new Error("authorization revoked"), { code: "invalid_grant" });
    },
    markReauthorizationRequired: async () => { marked = true; },
  }));
  await assert.rejects(send(sendInput()), /authorization revoked/);
  assert.equal(marked, true);
});

test("multiple user identities get isolated refresh tokens and Gmail clients", async () => {
  const clientTokens: string[] = [];
  const userEmails = new Map([
    ["user-a", { email: "a@example.com", googleSub: "sub-a" }],
    ["user-b", { email: "b@example.com", googleSub: "sub-b" }],
  ]);
  const dependencies: GmailServiceDependencies = {
    loadAuthorization: async (targetUserId) => ({
      userId: targetUserId,
      ...userEmails.get(targetUserId)!,
      refreshToken: `token-${targetUserId}`,
    }),
    markReauthorizationRequired: async () => {},
    createClient: async (token) => {
      clientTokens.push(token);
      const targetUserId = token.replace("token-", "");
      const identity = userEmails.get(targetUserId);
      return createMockClient({ getAuthenticatedIdentity: async () => identity! });
    },
  };
  const send = createGmailEmailService(dependencies);
  for (const [id, info] of userEmails) {
    await send(sendInput({
      userId: id,
      senderAddress: info.email,
    }));
  }
  assert.deepEqual(clientTokens, ["token-user-a", "token-user-b"]);
});

test("OAuth refresh invokes the refresh-token flow before Gmail API use", async () => {
  let refreshed = false;
  await refreshGmailAccessToken(async () => {
    refreshed = true;
    return { token: "mock-access-token" };
  });
  assert.equal(refreshed, true);
});

test("Google adapter calls Gmail users.messages.send with userId me", async () => {
  const calls: string[] = [];
  const client = createGmailApiAdapter({
    refreshAccessToken: async () => { calls.push("refresh"); },
    getUserInfo: async () => {
      calls.push("identity");
      return { data: { id: "google-sub-1", email: "sender@example.com" } };
    },
    sendMessage: async (request) => {
      assert.equal(request.userId, "me");
      assert.equal(request.requestBody.raw, "mock-mime");
      calls.push("send");
      return { data: { id: "api-message-id", threadId: "api-thread-id" } };
    },
  });
  assert.deepEqual(await client.getAuthenticatedIdentity(), {
    email: "sender@example.com",
    googleSub: "google-sub-1",
  });
  assert.deepEqual(await client.sendMessage("mock-mime"), {
    id: "api-message-id",
    threadId: "api-thread-id",
  });
  assert.deepEqual(calls, ["refresh", "identity", "send"]);
});

let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";
const reconnectUser = {
  id: userId,
  name: "Test Sender",
  email: "sender@example.com",
  avatarUrl: null,
};

before(async () => {
  const app = express();
  app.use(session({
    name: "gmail-test.sid",
    secret: "test-session-secret-with-at-least-thirty-two-characters",
    resave: false,
    saveUninitialized: false,
  }));
  app.post("/__test/login", (req, res) => {
    req.session.user = reconnectUser;
    req.session.save((error) => error ? res.status(500).end() : res.status(204).end());
  });
  app.use(
    "/api/integrations/gmail",
    requireAuth,
    createGmailIntegrationRouter({
      createAuthorizationUrl: (state) => `https://accounts.google.com/mock?state=${state}`,
      verifyCode: async () => ({
        profile: {
          sub: "google-sub-1",
          email: "sender@example.com",
          email_verified: true,
        },
        refreshToken: "secret-mock-token",
        scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send"],
      }),
      saveAuthorization: async (targetUserId) => {
        assert.equal(targetUserId, reconnectUser.id);
      },
      getStatus: async () => ({
        connected: true,
        email: "sender@example.com",
        status: "connected",
      }),
    })
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("authenticated Gmail reconnect is state-bound and never returns tokens", async () => {
  const login = await fetch(`${baseUrl}/__test/login`, { method: "POST", redirect: "manual" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const connect = await fetch(`${baseUrl}/api/integrations/gmail/connect`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(connect.status, 302);
  const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);
  const callback = await fetch(
    `${baseUrl}/api/integrations/gmail/callback?code=mock-code&state=${state}`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(callback.status, 303);
  const redirect = callback.headers.get("location") ?? "";
  assert.match(redirect, /gmail=connected/);
  assert.doesNotMatch(redirect, /secret-mock-token|refresh_token|access_token/);
});
