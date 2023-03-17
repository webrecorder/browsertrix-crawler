import Redis from "ioredis";
import { logger } from "./logger.js";

const error = console.error;

let lastLogTime = 0;

// log only once every 10 seconds
const REDIS_ERROR_LOG_INTERVAL_SECS = 10000;

console.error = function (...args) {
  if (
    typeof args[0] === "string" &&
    args[0].indexOf("[ioredis] Unhandled error event") === 0
  ) {

    let now = Date.now();

    if ((now - lastLogTime) > REDIS_ERROR_LOG_INTERVAL_SECS) {
      logger.warn("ioredis error", {error: args[0]}, "redis");
      lastLogTime = now;
    }
    return;
  }
  error.call(console, ...args);
};

export async function initRedis(url) {
  const redis = new Redis(url, {lazyConnect: true});
  await redis.connect();
  return redis;
}
