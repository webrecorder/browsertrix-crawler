#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./crawler.js";
import { ReplayCrawler } from "./replaycrawler.js";
import fs from "node:fs";
import { ExitCodes, InterruptReason } from "./util/constants.js";

let crawler: Crawler | null = null;

let lastSigInt = 0;
let forceTerm = false;

async function handleTerminate(signame: string) {
  logger.info(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    logger.error("error: no crawler running, exiting");
    process.exit(ExitCodes.GenericError);
  }

  if (crawler.done) {
    logger.info("success: crawler done, exiting");
    process.exit(ExitCodes.Success);
  }

  setExitOnRedisError();

  try {
    await crawler.checkCanceled();

    if (!crawler.interruptReason) {
      logger.info(
        "SIGNAL: interrupt request received, finishing current pages before exit...",
      );
      crawler.gracefulFinishOnInterrupt(InterruptReason.SignalInterrupted);
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

if (process.argv[1].endsWith("qa")) {
  crawler = new ReplayCrawler();
} else {
  crawler = new Crawler();
}

// remove any core dumps which could be taking up space in the working dir
try {
  fs.unlinkSync("./core");
} catch (e) {
  //ignore
}

await crawler.run();
