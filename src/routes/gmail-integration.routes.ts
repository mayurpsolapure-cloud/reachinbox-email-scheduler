import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import {
  createGoogleAuthorizationUrl,
  verifyGoogleAuthorizationCode,
} from "../services/auth.service.js";
import {
  getGmailAuthorizationStatus,
  saveGmailAuthorization,
} from "../services/gmail-auth.service.js";

const STATE_TTL_MS = 10 * 60 * 1000;

function frontendUrl(): string {
  const value = process.env.FRONTEND_URL;
  if (!value) throw new Error("FRONTEND_URL is required");
  return new URL(value).origin;
}

function redirectToFrontend(res: Response, result: "connected" | "error", reason?: string) {
  const redirect = new URL("/settings", frontendUrl());
  if (result === "connected") {
    redirect.searchParams.set("gmail", "connected");
  } else {
    redirect.searchParams.set("gmailError", reason ?? "connection_failed");
  }
  return res.redirect(303, redirect.toString());
}

export function createGmailIntegrationRouter(
  dependencies = {
    createAuthorizationUrl: (state: string) => createGoogleAuthorizationUrl(state, "gmail"),
    verifyCode: (code: string) => verifyGoogleAuthorizationCode(code, "gmail"),
    saveAuthorization: saveGmailAuthorization,
    getStatus: getGmailAuthorizationStatus,
  }
) {
  const router = Router();

  router.get("/connect", (req, res, next) => {
    const state = randomBytes(32).toString("base64url");
    req.session.gmailOauthState = state;
    req.session.gmailOauthStateCreatedAt = Date.now();
    if (req.user) req.session.gmailOauthUserId = req.user.id;
    else delete req.session.gmailOauthUserId;
    req.session.save((error) => {
      if (error) return next(error);
      try {
        return res.redirect(302, dependencies.createAuthorizationUrl(state));
      } catch {
        delete req.session.gmailOauthState;
        delete req.session.gmailOauthStateCreatedAt;
        delete req.session.gmailOauthUserId;
        return redirectToFrontend(res, "error", "configuration");
      }
    });
  });

  router.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;
    const expectedState = req.session.gmailOauthState;
    const stateCreatedAt = req.session.gmailOauthStateCreatedAt;
    const expectedUserId = req.session.gmailOauthUserId;
    delete req.session.gmailOauthState;
    delete req.session.gmailOauthStateCreatedAt;
    delete req.session.gmailOauthUserId;

    if (
      typeof state !== "string" ||
      !expectedState ||
      typeof stateCreatedAt !== "number" ||
      stateCreatedAt > Date.now() ||
      Date.now() - stateCreatedAt > STATE_TTL_MS
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
    if (!expectedUserId || expectedUserId !== req.user?.id) {
      return redirectToFrontend(res, "error", "account_mismatch");
    }

    try {
      const authorization = await dependencies.verifyCode(code);
      if (!authorization.scopes.includes("https://www.googleapis.com/auth/gmail.send")) {
        return redirectToFrontend(res, "error", "permission_denied");
      }
      await dependencies.saveAuthorization(
        expectedUserId,
        authorization.profile,
        authorization.refreshToken,
        authorization.scopes,
        { requireFreshRefreshToken: true }
      );
      const status = await dependencies.getStatus(expectedUserId);
      if (!status.connected) {
        return redirectToFrontend(res, "error", "missing_refresh_token");
      }
      return redirectToFrontend(res, "connected");
    } catch (reason) {
      if (
        reason instanceof Error &&
        reason.message.includes("does not match the signed-in Google account")
      ) {
        return redirectToFrontend(res, "error", "account_mismatch");
      }
      console.error("Gmail OAuth callback could not complete");
      return redirectToFrontend(res, "error", "connection_failed");
    }
  });

  router.get("/status", async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    try {
      return res.json(await dependencies.getStatus(userId));
    } catch (reason) {
      return next(reason);
    }
  });

  return router;
}

export default createGmailIntegrationRouter();
