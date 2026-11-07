import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createApiCorsMiddleware } from "../src/middleware/api-cors.js";

async function withServer(
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(createApiCorsMiddleware("https://frontend.example"));
  app.get("/", (_request, response) => response.status(200).send("ok"));
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("allows credentialed requests only from the configured frontend", async () => {
  await withServer(async (baseUrl) => {
    const allowed = await fetch(baseUrl, {
      headers: { Origin: "https://frontend.example" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://frontend.example");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    assert.equal(allowed.headers.get("vary"), "Origin");

    const denied = await fetch(baseUrl, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });
});

test("allows preflight only for the configured frontend and requested headers", async () => {
  await withServer(async (baseUrl) => {
    const allowed = await fetch(baseUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://frontend.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-methods"), "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    assert.equal(allowed.headers.get("access-control-allow-headers"), "Content-Type,Authorization");

    const denied = await fetch(baseUrl, {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(denied.status, 403);
  });
});

test("serves same-origin requests without a CORS allow-origin header", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});
