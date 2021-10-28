const Redis = require("ioredis");

module.exports.initRedis = async function(url) {
  const redis = new Redis(url, {lazyConnect: true});
  await redis.connect();
  return redis;
};
