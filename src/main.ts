#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./crawler.js";
import { parseArgs } from "./util/argParser.js";
import { ReplayCrawler } from "./replaycrawler.js";

let crawler: Crawler | null = null;

let lastSigInt = 0;
let forceTerm = false;

async function handleTerminate(signame: string) {
  logger.info(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    logger.error("error: no crawler running, exiting");
    process.exit(1);
  }

  if (crawler.done) {
    logger.info("success: crawler done, exiting");
    process.exit(0);
  }

  setExitOnRedisError();

  try {
    crawler.checkCanceled();

    if (!crawler.interrupted) {
      logger.info("SIGNAL: gracefully finishing current pages...");
      crawler.gracefulFinishOnInterrupt();
    } else if (forceTerm || Date.now() - lastSigInt > 200) {
      logger.info("SIGNAL: stopping crawl now...");
      await crawler.serializeAndExit();
    }
    lastSigInt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    logger.error("Error stopping crawl after receiving termination signal", e);
  }
}

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  logger.info("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
  forceTerm = true;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const args = parseArgs() as any;

if (args.parsed.replaySource) {
  crawler = new ReplayCrawler(args);
} else {
  crawler = new Crawler(args);
}

crawler.run();
