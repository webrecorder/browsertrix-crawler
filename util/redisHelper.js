import {logger} from "./logger.js";

export class RedisHelper{

  constructor(redis) {
    this.redis = redis;
  }

  async pushEventToQueue(queueName, event) {
    try {
      await this.redis.rpush(queueName, event);
      logger.info(`Event pushed to the ${queueName} queue: ${event}`);
    } catch (error) {
      logger.error("Error pushing event to queue:", error);
    }
  }
}