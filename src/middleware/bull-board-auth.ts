import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeCompare(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return (
    first.length === second.length &&
    timingSafeEqual(first, second)
  );
}

export function bullBoardAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const username = process.env.BULL_BOARD_USER;
  const password = process.env.BULL_BOARD_PASSWORD;

  const header = req.headers.authorization;

  if (!username || !password || !header?.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
    return res.status(401).send("Authentication required");
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");

    if (separator < 0) {
      return res.status(401).send("Invalid credentials");
    }

    const suppliedUser = decoded.slice(0, separator);
    const suppliedPassword = decoded.slice(separator + 1);

    if (
      !safeCompare(suppliedUser, username) ||
      !safeCompare(suppliedPassword, password)
    ) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
      return res.status(401).send("Invalid credentials");
    }

    next();
  } catch {
    return res.status(401).send("Invalid authorization header");
  }
}