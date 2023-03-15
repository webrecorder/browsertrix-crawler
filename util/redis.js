import Redis from "ioredis";
import { Logger } from "./logger.js";

const logger = new Logger();

export async function initRedis(url) {
  const redis = new Redis(url, {lazyConnect: true});
  await redis.connect();
  return redis;
}

const error = console.error;

console.error = function (...args) {
  if (
    typeof args[0] === "string" &&
    args[0].indexOf("[ioredis] Unhandled error event") === 0
  ) {
    logger.warn("ioredis error", {error: args[0]}, "redis");
    return;
  }
  error.call(console, ...args);
};
