#!/usr/bin/env -S node --experimental-global-webcrypto

import { Crawler } from "./crawler.js";

var crawler = null;

var lastSigInt = 0;
let forceTerm = false;


async function handleTerminate(signame) {
  console.log(`${signame} received...`);
  if (!crawler || !crawler.crawlState) {
    console.log("error: no crawler running, exiting");
    process.exit(1);
  }

  if (crawler.done) {
    console.log("success: crawler done, exiting");
    process.exit(0);
  }

  try {
    if (!crawler.crawlState.drainMax) {
      console.log("SIGNAL: gracefully finishing current pages...");
      crawler.gracefulFinish();

    } else if (forceTerm || (Date.now() - lastSigInt) > 200) {
      console.log("SIGNAL: stopping crawl now...");
      await crawler.serializeAndExit();
    }
    lastSigInt = Date.now();
  } catch (e) {
    console.log(e);
  }
}

process.on("SIGINT", () => handleTerminate("SIGINT"));

process.on("SIGTERM", () => handleTerminate("SIGTERM"));

process.on("SIGABRT", async () => {
  console.log("SIGABRT received, will force immediate exit on SIGTERM/SIGINT");
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


