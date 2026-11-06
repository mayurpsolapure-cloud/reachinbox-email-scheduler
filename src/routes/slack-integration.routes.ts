import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import {
  createSlackAuthorizationUrl,
  disconnectSlack,
  exchangeSlackAuthorizationCode,
  getSlackConnectionStatus,
  saveSlackConnection,
} from "../services/slack.service.js";

type SlackDetails = Awaited<ReturnType<typeof exchangeSlackAuthorizationCode>>;
const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type SlackIntegrationDependencies = {
  createAuthorizationUrl: (state: string) => string;
  exchangeCode: (code: string) => Promise<SlackDetails>;
  saveConnection: (userId: string, details: SlackDetails) => Promise<void>;
  getStatus: (userId: string) => Promise<Awaited<ReturnType<typeof getSlackConnectionStatus>>>;
  disconnect: (userId: string) => Promise<void>;
};

function frontendUrl(): string {
  const value = process.env.FRONTEND_URL;
  if (!value) throw new Error("FRONTEND_URL is required");
  return new URL(value).origin;
}

function redirectToFrontend(res: Response, result: "connected" | "error", reason?: string) {
  const redirect = new URL("/scheduled", frontendUrl());
  if (result === "connected") {
    redirect.searchParams.set("slack", "connected");
  } else {
    redirect.searchParams.set("slackError", reason ?? "connection_failed");
  }
  return res.redirect(303, redirect.toString());
}

export function createSlackIntegrationRouter(
  dependencies: SlackIntegrationDependencies = {
    createAuthorizationUrl: createSlackAuthorizationUrl,
    exchangeCode: exchangeSlackAuthorizationCode,
    saveConnection: saveSlackConnection,
    getStatus: getSlackConnectionStatus,
    disconnect: disconnectSlack,
  }
) {
  const router = Router();

  router.get("/connect", (req, res, next) => {
    const state = randomBytes(32).toString("base64url");
    req.session.slackOauthState = state;
    req.session.slackOauthStateCreatedAt = Date.now();
    req.session.save((error) => {
      if (error) return next(error);
      try {
        return res.redirect(302, dependencies.createAuthorizationUrl(state));
      } catch {
        delete req.session.slackOauthState;
        return redirectToFrontend(res, "error", "configuration");
      }
    });
  });

  router.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;
    const expectedState = req.session.slackOauthState;
    const stateCreatedAt = req.session.slackOauthStateCreatedAt;
    delete req.session.slackOauthState;
    delete req.session.slackOauthStateCreatedAt;

    if (
      typeof state !== "string" ||
      !expectedState ||
      typeof stateCreatedAt !== "number" ||
      stateCreatedAt > Date.now() ||
      Date.now() - stateCreatedAt > SLACK_OAUTH_STATE_TTL_MS
    ) {
      return redirectToFrontend(res, "error", "invalid_state");
    }
    const received = Buffer.from(state);
    const expected = Buffer.from(expectedState);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return redirectToFrontend(res, "error", "invalid_state");
    }
    if (typeof error === "string" || typeof code !== "string" || !code) {
      return redirectToFrontend(res, "error", "cancelled");
    }

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    try {
      const details = await dependencies.exchangeCode(code);
      await dependencies.saveConnection(userId, details);
      return redirectToFrontend(res, "connected");
    } catch {
      console.error("Slack OAuth callback could not complete");
      return redirectToFrontend(res, "error", "connection_failed");
    }
  });

  router.get("/status", async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    try {
      return res.json(await dependencies.getStatus(userId));
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/disconnect", async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    try {
      await dependencies.disconnect(userId);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createSlackIntegrationRouter();
