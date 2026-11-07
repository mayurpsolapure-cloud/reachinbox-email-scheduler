import express from "express";
import { connectDatabase, pool } from "./config/database.js";
import campaignRoutes from "./routes/campaign.routes.js";
import leadRoutes from "./routes/lead.routes.js";
import schedulerRoutes from "./routes/scheduler.routes.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { emailQueue, redisConnection } from "./queue/email.queue.js";
import { bullBoardAuth } from "./middleware/bull-board-auth.js";
import {
  connectElasticsearch,
  elasticsearchClient,
} from "./config/elasticsearch.js";
import searchRoutes from "./routes/search.routes.js";
import { backfillSentEmails } from "./services/email-search.service.js";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import authRoutes from "./routes/auth.routes.js";
import { requireAuth } from "./middleware/require-auth.js";
import { validateAuthEnvironment } from "./services/auth.service.js";
import slackIntegrationRoutes from "./routes/slack-integration.routes.js";
import gmailIntegrationRoutes from "./routes/gmail-integration.routes.js";
import { createApiRateLimiter } from "./middleware/api-rate-limit.js";
import { createApiCorsMiddleware } from "./middleware/api-cors.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const serverAdapter = new ExpressAdapter();
const PgSession = connectPgSimple(session);

serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});
app.use(express.json());
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}
app.use(createApiCorsMiddleware(process.env.FRONTEND_URL ?? "http://localhost:5173"));
app.use(
  session({
    name: "reachinbox.sid",
    store: new PgSession({
      pool,
      createTableIfMissing: true,
      tableName: "user_sessions",
    }),
    secret: process.env.SESSION_SECRET ?? "",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    },
  })
);
app.use(
  "/admin/queues",
  bullBoardAuth,
  serverAdapter.getRouter()
);
app.get("/", (_req, res) => {
  res.json({
    status: "OK",
    message: "ReachInbox Email Scheduler API is running",
  });
});

app.get("/health/live", (_req, res) => {
  res.json({ status: "live" });
});

app.get("/health/ready", async (_req, res) => {
  const [database, redis, elasticsearch] = await Promise.allSettled([
    pool.query("SELECT 1"),
    redisConnection.ping(),
    elasticsearchClient.info(),
  ]);
  const dependencies = {
    database: database.status === "fulfilled" ? "ready" : "unavailable",
    redis: redis.status === "fulfilled" ? "ready" : "unavailable",
    elasticsearch: elasticsearch.status === "fulfilled" ? "ready" : "unavailable",
  };
  const ready = Object.values(dependencies).every((state) => state === "ready");
  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    dependencies,
  });
});

app.get("/health/db", async (_req, res) => {
  const result = await pool.query("SELECT NOW() AS current_time");

  res.json({
    status: "OK",
    database: "Connected",
    time: result.rows[0].current_time,
  });
});

app.use(
  "/api/auth",
  createApiRateLimiter(redisConnection, {
    key: "auth",
    maxRequests: 30,
    windowMs: 60_000,
  }),
  authRoutes
);
app.use("/api", requireAuth);
app.use(
  "/api/integrations/slack",
  createApiRateLimiter(redisConnection, {
    key: "slack-integration",
    maxRequests: 30,
    windowMs: 60_000,
  }),
  slackIntegrationRoutes
);
app.use("/api/integrations/gmail", gmailIntegrationRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api", schedulerRoutes);
app.use("/api", searchRoutes);

async function startServer() {
  validateAuthEnvironment();
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required in production");
    if (!process.env.ELASTICSEARCH_URL) throw new Error("ELASTICSEARCH_URL is required in production");
  }
  await connectDatabase();

  try {
    await connectElasticsearch();
    await backfillSentEmails();
  } catch (error) {
    console.error("Elasticsearch initialization error:", error);
    if (process.env.NODE_ENV === "production") {
      throw new Error("Elasticsearch initialization failed; refusing to start without search");
    }
    console.error("Elasticsearch initialization failed; search and readiness remain unavailable.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});

export default app;