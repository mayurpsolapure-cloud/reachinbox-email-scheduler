import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

export type SlackNotificationData = {
  userId: string;
  senderEmail: string;
  hourlyLimit: number;
  eventAt: string;
  delayedEmails: number;
};

export const redisConnection = createRedisConnection();

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