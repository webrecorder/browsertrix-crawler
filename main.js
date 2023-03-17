#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { Crawler } from "./crawler.js";

var crawler = null;

var lastSigInt = 0;
let forceTerm = false;


async function handleTerminate(signame) {
  logger.info(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    logger.error("error: no crawler running, exiting");
    process.exit(1);
  }

  if (crawler.done) {
    logger.info("success: crawler done, exiting");
    process.exit(0);
  }

  try {
    if (!crawler.interrupted) {
      logger.info("SIGNAL: gracefully finishing current pages...");
      crawler.gracefulFinish();

    } else if (forceTerm || (Date.now() - lastSigInt) > 200) {
      logger.info("SIGNAL: stopping crawl now...");
      await crawler.serializeAndExit();
    }
    lastSigInt = Date.now();
  } catch (e) {
    logger.error("Error stopping crawl after receiving termination signal", e);
  }
}

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  logger.info("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
  forceTerm = true;
});

process.on("SIGUSR1", () => {
  if (crawler) {
    crawler.prepareForExit(true);
  }
});

process.on("SIGUSR2", () => {
  if (crawler) {
    crawler.prepareForExit(false);
  }
});

crawler = new Crawler();
crawler.run();


