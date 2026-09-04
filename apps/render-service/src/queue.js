import { Queue } from "bullmq";

import { config } from "./config.js";

/** Shared by the server (producer) and the worker (consumer). */
export const redisConnection = {
  host: config.redis.host,
  port: config.redis.port,
  // BullMQ requires this for blocking commands.
  maxRetriesPerRequest: null,
};

export function createQueue() {
  return new Queue(config.queueName, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}

/**
 * Maps BullMQ's internal states onto the four the API promises:
 * pending | processing | done | failed.
 */
export function toApiStatus(bullState) {
  switch (bullState) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "active":
      return "processing";
    case "waiting":
    case "waiting-children":
    case "delayed":
    case "prioritized":
    case "paused":
      return "pending";
    default:
      return "pending";
  }
}
