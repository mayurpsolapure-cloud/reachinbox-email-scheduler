import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";

const RATE_LIMIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("PTTL", KEYS[1]) }
`;

export type ApiRateLimitOptions = {
  key: string;
  maxRequests: number;
  windowMs: number;
};

export function createApiRateLimiter(
  redis: Redis,
  options: ApiRateLimitOptions
) {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) {
    throw new Error("API rate limit maxRequests must be a positive integer");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1000) {
    throw new Error("API rate limit windowMs must be an integer of at least 1000");
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = req.ip || req.socket.remoteAddress || "unknown";
    const identityHash = createHash("sha256")
      .update(`${options.key}:${identity}`)
      .digest("hex");
    const window = Math.floor(Date.now() / options.windowMs);
    const redisKey = `api-rate-limit:${identityHash}:${window}`;

    try {
      const result = await redis.eval(
        RATE_LIMIT_SCRIPT,
        1,
        redisKey,
        String(options.windowMs)
      ) as [number | string, number | string];
      const requestCount = Number(result[0]);
      const remainingMs = Math.max(1000, Number(result[1]));
      res.setHeader("RateLimit-Limit", String(options.maxRequests));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, options.maxRequests - requestCount)));
      if (requestCount > options.maxRequests) {
        res.setHeader("Retry-After", String(Math.ceil(remainingMs / 1000)));
        return res.status(429).json({ error: "Too many requests. Please retry later." });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
