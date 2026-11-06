import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedUser } from "../types/express-session.js";
import {
  createGoogleAuthorizationUrl,
  findOrCreateGoogleUser,
  verifyGoogleAuthorizationCode,
} from "../services/auth.service.js";

export type GoogleProfile = Awaited<ReturnType<typeof verifyGoogleAuthorizationCode>>;
export type AuthDependencies = {
  createAuthorizationUrl: (state: string) => string;
  verifyCode: (code: string) => Promise<GoogleProfile>;
  findOrCreateUser: (profile: GoogleProfile) => Promise<AuthenticatedUser>;
};

function frontendUrl(): string {
  const value = process.env.FRONTEND_URL;
  if (!value) throw new Error("FRONTEND_URL is required");
  return new URL(value).origin;
}

function redirectWithError(res: Response, code: string) {
  const redirect = new URL("/login", frontendUrl());
  redirect.searchParams.set("authError", code);
  return res.redirect(303, redirect.toString());
}

export function createAuthRouter(
  dependencies: AuthDependencies = {
    createAuthorizationUrl: createGoogleAuthorizationUrl,
    verifyCode: verifyGoogleAuthorizationCode,
    findOrCreateUser: findOrCreateGoogleUser,
  }
) {
  const router = Router();

  router.get("/google", (req, res, next) => {
    try {
      const state = randomBytes(32).toString("base64url");
      req.session.oauthState = state;
      req.session.save((error) => {
        if (error) return next(error);
        try {
          return res.redirect(302, dependencies.createAuthorizationUrl(state));
        } catch (reason) {
          return next(reason);
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/google/callback", async (req, res, next) => {
    const { code, state, error } = req.query;
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (typeof state !== "string" || !expectedState) {
      return redirectWithError(res, "invalid_state");
    }
    const received = Buffer.from(state);
    const expected = Buffer.from(expectedState);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return redirectWithError(res, "invalid_state");
    }
    if (typeof error === "string" || typeof code !== "string" || !code) {
      return redirectWithError(res, "google_denied");
    }

    try {
      const profile = await dependencies.verifyCode(code);
      if (profile.email_verified !== true) {
        return redirectWithError(res, "google_auth_failed");
      }
      const user = await dependencies.findOrCreateUser(profile);
      req.session.regenerate((regenerateError) => {
        if (regenerateError) return next(regenerateError);
        req.session.user = user;
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          return res.redirect(303, new URL("/scheduled", frontendUrl()).toString());
        });
      });
    } catch {
      return redirectWithError(res, "google_auth_failed");
    }
  });

  router.get("/me", (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    return res.json({ user: req.session.user });
  });

  router.post("/logout", (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("reachinbox.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      return res.status(204).end();
    });
  });

  return router;
}

export default createAuthRouter();
