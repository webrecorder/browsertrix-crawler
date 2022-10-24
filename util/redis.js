import Redis from "ioredis";

export async function initRedis(url) {
  const redis = new Redis(url, {lazyConnect: true});
  await redis.connect();
  return redis;
}
