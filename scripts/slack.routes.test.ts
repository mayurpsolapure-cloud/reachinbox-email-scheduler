import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import {
  createSlackAuthorizationUrl,
  exchangeSlackAuthorizationCode,
} from "../src/services/slack.service.js";
import type { SlackWebhookDetails } from "../src/services/slack.service.js";
import {
  createSlackIntegrationRouter,
} from "../src/routes/slack-integration.routes.js";
import { requireAuth } from "../src/middleware/require-auth.js";

process.env.FRONTEND_URL = "http://localhost:5173";
process.env.SLACK_CLIENT_ID = "test-slack-client";
process.env.SLACK_CLIENT_SECRET = "test-slack-secret";
process.env.SLACK_REDIRECT_URI = "http://localhost:5000/api/integrations/slack/callback";
process.env.SLACK_WEBHOOK_ENCRYPTION_KEY = "11".repeat(32);

const userId = "00000000-0000-4000-8000-000000000001";
const firstConnection = {
  teamId: "T111",
  teamName: "Example Workspace",
  channelId: "C111",
  channelName: "alerts",
  webhookUrl: "https://hooks.slack.com/services/T111/B111/secret111",
};
const secondConnection = {
  ...firstConnection,
  teamId: "T222",
  teamName: "Reconnected Workspace",
  channelId: "C222",
  channelName: "email-alerts",
  webhookUrl: "https://hooks.slack.com/services/T222/B222/secret222",
};

let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";
let exchangeCount = 0;
let savedUserId = "";
let savedConnection: SlackWebhookDetails = firstConnection;
let disconnected = false;

before(async () => {
  const app = express();
  app.use(session({
    name: "reachinbox.slack-test",
    secret: "test-session-secret-with-at-least-thirty-two-characters",
    resave: false,
    saveUninitialized: false,
  }));
  app.post("/__test/login", (req, res) => {
    const id = typeof req.query.userId === "string" ? req.query.userId : userId;
    req.session.user = {
      id,
      name: "Slack Test User",
      email: `${id}@example.invalid`,
      avatarUrl: null,
    };
    req.session.save((error) => error ? res.status(500).end() : res.status(204).end());
  });
  app.post("/__test/expire-state", (req, res) => {
    req.session.slackOauthStateCreatedAt = Date.now() - 11 * 60 * 1000;
    req.session.save((error) => error ? res.status(500).end() : res.status(204).end());
  });
  app.use("/api", requireAuth);
  app.use("/api/integrations/slack", createSlackIntegrationRouter({
    createAuthorizationUrl: createSlackAuthorizationUrl,
    exchangeCode: async (code) => {
      exchangeCount += 1;
      if (code !== "valid-code") throw new Error("Slack rejected the authorization code");
      return savedConnection;
    },
    saveConnection: async (ownerId, details) => {
      savedUserId = ownerId;
      savedConnection = details;
      disconnected = false;
    },
    getStatus: async () => disconnected
      ? { connected: false }
      : {
          connected: true,
          teamName: savedConnection.teamName,
          channelName: savedConnection.channelName,
          connectedAt: new Date(),
        },
    disconnect: async () => {
      disconnected = true;
    },
  }));
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

async function beginSlackConnect() {
  const login = await fetch(`${baseUrl}/__test/login`, { method: "POST" });
  assert.equal(login.status, 204);
  const initialCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(initialCookie);
  const response = await fetch(`${baseUrl}/api/integrations/slack/connect`, {
    headers: { cookie: initialCookie },
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? initialCookie;
  return { location, cookie };
}

test("Slack OAuth scopes, state validation, tenant binding, disconnect and reconnect", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/integrations/slack/connect`, {
    redirect: "manual",
  });
  assert.equal(unauthenticated.status, 401);

  const { location, cookie } = await beginSlackConnect();
  assert.equal(location.hostname, "slack.com");
  assert.equal(location.pathname, "/oauth/v2/authorize");
  assert.equal(location.searchParams.get("scope"), "incoming-webhook");
  assert.equal(location.searchParams.get("client_id"), "test-slack-client");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "http://localhost:5000/api/integrations/slack/callback"
  );
  assert.equal(location.searchParams.get("state")?.length, 43);
  const nextLogin = await beginSlackConnect();
  assert.notEqual(nextLogin.location.searchParams.get("state"), location.searchParams.get("state"));

  const invalidState = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=wrong`,
    { headers: { cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(invalidState.headers.get("location") ?? "").searchParams.get("slackError"),
    "invalid_state"
  );
  assert.equal(exchangeCount, 0);

  const login = await beginSlackConnect();
  await fetch(`${baseUrl}/__test/expire-state`, {
    method: "POST",
    headers: { cookie: login.cookie },
  });
  const expiredState = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=${encodeURIComponent(login.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: login.cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(expiredState.headers.get("location") ?? "").searchParams.get("slackError"),
    "invalid_state"
  );
  assert.equal(exchangeCount, 0);

  const validLogin = await beginSlackConnect();
  const callback = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=${encodeURIComponent(validLogin.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: validLogin.cookie }, redirect: "manual" }
  );
  assert.equal(callback.status, 303);
  assert.equal(
    new URL(callback.headers.get("location") ?? "").searchParams.get("slack"),
    "connected"
  );
  assert.equal(savedUserId, userId);
  assert.equal(exchangeCount, 1);
  const replay = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=${encodeURIComponent(validLogin.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: validLogin.cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(replay.headers.get("location") ?? "").searchParams.get("slackError"),
    "invalid_state"
  );

  const statusResponse = await fetch(`${baseUrl}/api/integrations/slack/status`, {
    headers: { cookie: validLogin.cookie },
  });
  const status = await statusResponse.json() as {
    connected: boolean;
    teamName: string | null;
    channelName: string;
    connectedAt: string;
  };
  assert.equal(status.connected, true);
  assert.equal(status.teamName, "Example Workspace");
  assert.equal(status.channelName, "alerts");
  assert.ok(status.connectedAt);
  assert.equal(JSON.stringify(status).includes("secret111"), false);

  const disconnect = await fetch(`${baseUrl}/api/integrations/slack/disconnect`, {
    method: "DELETE",
    headers: { cookie: validLogin.cookie },
  });
  assert.equal(disconnect.status, 204);
  const disconnectedStatus = await fetch(`${baseUrl}/api/integrations/slack/status`, {
    headers: { cookie: validLogin.cookie },
  });
  assert.deepEqual(await disconnectedStatus.json(), { connected: false });

  savedConnection = secondConnection;
  const reconnect = await beginSlackConnect();
  const reconnectResponse = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=${encodeURIComponent(reconnect.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: reconnect.cookie }, redirect: "manual" }
  );
  assert.equal(reconnectResponse.status, 303);
  assert.equal(savedConnection.teamId, "T222");
  assert.equal(savedConnection.channelName, "email-alerts");
  assert.equal(savedConnection.webhookUrl, secondConnection.webhookUrl);
});

test("Slack callback rejects missing state, missing code and a different session", async () => {
  const login = await beginSlackConnect();
  const missingState = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code`,
    { headers: { cookie: login.cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(missingState.headers.get("location") ?? "").searchParams.get("slackError"),
    "invalid_state"
  );

  const missingCodeLogin = await beginSlackConnect();
  const missingCode = await fetch(
    `${baseUrl}/api/integrations/slack/callback?state=${encodeURIComponent(missingCodeLogin.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: missingCodeLogin.cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(missingCode.headers.get("location") ?? "").searchParams.get("slackError"),
    "cancelled"
  );

  const initiatingSession = await beginSlackConnect();
  const otherSessionResponse = await fetch(
    `${baseUrl}/__test/login?userId=00000000-0000-4000-8000-000000000002`,
    { method: "POST" }
  );
  const otherCookie = otherSessionResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(otherCookie);
  const crossSession = await fetch(
    `${baseUrl}/api/integrations/slack/callback?code=valid-code&state=${encodeURIComponent(initiatingSession.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: otherCookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(crossSession.headers.get("location") ?? "").searchParams.get("slackError"),
    "invalid_state"
  );
});

test("Slack OAuth code exchange accepts only a granted incoming webhook", async () => {
  let formBody = "";
  const details = await exchangeSlackAuthorizationCode(
    "mock-code",
    async (input, init) => {
      assert.equal(String(input), "https://slack.com/api/oauth.v2.access");
      assert.equal(init?.method, "POST");
      formBody = String(init?.body);
      return new Response(JSON.stringify({
        ok: true,
        team: { id: "T333", name: "Mock Workspace" },
        incoming_webhook: {
          url: "https://hooks.slack.com/services/T333/B333/mocktoken",
          channel_id: "C333",
          channel: "mock-alerts",
        },
      }), { status: 200 });
    }
  );
  assert.match(formBody, /client_id=test-slack-client/);
  assert.match(formBody, /client_secret=test-slack-secret/);
  assert.match(formBody, /code=mock-code/);
  assert.equal(details.teamId, "T333");
  assert.equal(details.channelName, "mock-alerts");
  assert.equal(details.webhookUrl, "https://hooks.slack.com/services/T333/B333/mocktoken");

  await assert.rejects(
    exchangeSlackAuthorizationCode("denied", async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200 })
    ),
    /did not grant an incoming webhook/
  );
  await assert.rejects(
    exchangeSlackAuthorizationCode("missing-webhook", async () =>
      new Response(JSON.stringify({
        ok: true,
        team: { id: "T333", name: "Mock Workspace" },
      }), { status: 200 })
    ),
    /did not grant an incoming webhook/
  );
  await assert.rejects(
    exchangeSlackAuthorizationCode("invalid-url", async () =>
      new Response(JSON.stringify({
        ok: true,
        team: { id: "T333", name: "Mock Workspace" },
        incoming_webhook: {
          url: "https://attacker.example/services/T333/B333/token",
          channel_id: "C333",
          channel: "mock-alerts",
        },
      }), { status: 200 })
    ),
    /invalid incoming webhook URL/
  );
  await assert.rejects(
    exchangeSlackAuthorizationCode("http-failure", async () =>
      new Response("Slack unavailable", { status: 503 })
    ),
    /token exchange failed/
  );

  const missingStateLogin = await beginSlackConnect();
  const slackError = await fetch(
    `${baseUrl}/api/integrations/slack/callback?error=access_denied&state=${encodeURIComponent(missingStateLogin.location.searchParams.get("state") ?? "")}`,
    { headers: { cookie: missingStateLogin.cookie }, redirect: "manual" }
  );
  assert.equal(
    new URL(slackError.headers.get("location") ?? "").searchParams.get("slackError"),
    "cancelled"
  );
});
