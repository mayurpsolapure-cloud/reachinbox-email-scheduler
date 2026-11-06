import { Queue } from "bullmq";
import { Redis } from "ioredis";

export type SlackNotificationData = {
  userId: string;
  senderEmail: string;
  hourlyLimit: number;
  eventAt: string;
  delayedEmails: number;
};

export const redisConnection = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue("email-sending", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: false,
    removeOnFail: false,
  },
});

export const slackNotificationQueue = new Queue<SlackNotificationData>(
  "slack-notifications",
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 86_400, count: 1000 },
      removeOnFail: false,
    },
  }
);