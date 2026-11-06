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
import { connectElasticsearch } from "./config/elasticsearch.js";
import searchRoutes from "./routes/search.routes.js";
import { backfillSentEmails } from "./services/email-search.service.js";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import authRoutes from "./routes/auth.routes.js";
import { requireAuth } from "./middleware/require-auth.js";
import { validateAuthEnvironment } from "./services/auth.service.js";
import slackIntegrationRoutes from "./routes/slack-integration.routes.js";
import { createApiRateLimiter } from "./middleware/api-rate-limit.js";

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
      sameSite: "lax",
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
app.use("/api/campaigns", campaignRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api", schedulerRoutes);
app.use("/api", searchRoutes);

async function startServer() {
  validateAuthEnvironment();
  await connectDatabase();

// Elasticsearch is a search service, so its failure
// should not prevent the main API from starting.
   try {
        await connectElasticsearch();
        await backfillSentEmails();
    } catch(error) {
        console.error("Elasticsearch initialization failed:", error);
   }

     app.listen(PORT, () => {
         console.log(`Server running at http://localhost:${PORT}`);
         });
}

startServer().catch((error: unknown) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});

export default app;