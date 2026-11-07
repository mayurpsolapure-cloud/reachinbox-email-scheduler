import type { NextFunction, Request, Response } from "express";

const ALLOWED_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization";

export function createApiCorsMiddleware(frontendUrl: string) {
  const allowedOrigin = new URL(frontendUrl).origin;

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("Origin");
    if (origin && origin !== allowedOrigin) {
      return res.status(403).json({ error: "Origin is not allowed" });
    }

    if (origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      if (!origin) return res.sendStatus(204);
      return res.status(204).end();
    }
    return next();
  };
}
