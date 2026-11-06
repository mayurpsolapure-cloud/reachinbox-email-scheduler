import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { createApiRateLimiter } from "../src/middleware/api-rate-limit.js";

const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});
const identityA = "192.0.2.11";
const identityB = "192.0.2.12";
const routeKey = `api-rate-test-${Date.now()}`;
const windowMs = 1000;
const bucket = Math.floor(Date.now() / windowMs);
const makeKey = (identity: string) =>
  `api-rate-limit:${createHash("sha256").update(`${routeKey}:${identity}`).digest("hex")}:${bucket}`;

let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";

before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createApiRateLimiter(redis, {
    key: routeKey,
    maxRequests: 2,
    windowMs,
  }));
  app.get("/resource", (_req, res) => res.status(200).json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await redis.del(makeKey(identityA), makeKey(identityB));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await redis.quit();
});

test("sensitive API limiter enforces a per-client window and resets it", async () => {
  for (let request = 0; request < 2; request += 1) {
    const response = await fetch(`${baseUrl}/resource`, {
      headers: { "x-forwarded-for": identityA },
    });
    assert.equal(response.status, 200);
  }

  const blocked = await fetch(`${baseUrl}/resource`, {
    headers: { "x-forwarded-for": identityA },
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);

  const otherClient = await fetch(`${baseUrl}/resource`, {
    headers: { "x-forwarded-for": identityB },
  });
  assert.equal(otherClient.status, 200);

  await new Promise((resolve) => setTimeout(resolve, Number(blocked.headers.get("retry-after")) * 1000 + 50));
  const afterWindow = await fetch(`${baseUrl}/resource`, {
    headers: { "x-forwarded-for": identityA },
  });
  assert.equal(afterWindow.status, 200);
});
