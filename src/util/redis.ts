import { Redis } from "ioredis";
import { logger } from "./logger.js";
import { sleep } from "./timing.js";

const error = console.error;

let lastLogTime = 0;
let exitOnError = false;

// log only once every 10 seconds
const REDIS_ERROR_LOG_INTERVAL_SECS = 10000;

console.error = function (...args) {
  if (
    typeof args[0] === "string" &&
    args[0].indexOf("[ioredis] Unhandled error event") === 0
  ) {
    const now = Date.now();

    if (now - lastLogTime > REDIS_ERROR_LOG_INTERVAL_SECS) {
      if (lastLogTime && exitOnError) {
        logger.fatal("Crawl interrupted, redis gone, exiting", {}, "redis");
      }
      logger.warn("ioredis error", { error: args[0] }, "redis");
      lastLogTime = now;
    }
    return;
  }
  error.call(console, ...args);
};

export async function initRedis(url: string) {
  const redis = new Redis(url, { lazyConnect: true });
  await redis.connect();
  return redis;
}

export async function initRedisWaitForSuccess(redisUrl: string, retrySecs = 1) {
  while (true) {
    try {
      return await initRedis(redisUrl);
    } catch (e) {
      logger.warn(`Waiting for redis at ${redisUrl}`, {}, "state");
      await sleep(retrySecs);
    }
  }
}

export function setExitOnRedisError() {
  exitOnError = true;
}
