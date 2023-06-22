import Redis from "ioredis";

export async function initBroadCrawlRedis() {
  const board_crawl_redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  });
  await board_crawl_redis.connect();
  return board_crawl_redis;
}