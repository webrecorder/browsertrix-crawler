import Redis from "ioredis";
// import dotenv from "dotenv";
//
// dotenv.config({path: "/.env"});

export async function initBroadCrawlRedis() {
  const board_crawl_redis = new Redis({
    host: process.env.BROAD_CRAWL_REDIS_HOST,
    port: process.env.BROAD_CRAWL_REDIS_PORT,
    password: process.env.BROAD_CRAWL_REDIS_PASSWORD,
    lazyConnect: true
  });
  await board_crawl_redis.connect();
  return board_crawl_redis;
}