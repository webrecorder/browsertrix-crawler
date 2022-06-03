#!/usr/bin/env node

var crawler = null;

var lastSigInt = 0;
let forceTerm = false;


async function handleTerminate() {
  if (!crawler || !crawler.crawlState) {
    process.exit(0);
  }

  try {
    if (!crawler.crawlState.drainMax) {
      console.log("SIGNAL: gracefully finishing current pages...");
      crawler.crawlState.setDrain(crawler.finalExit);

    } else if ((Date.now() - lastSigInt) > 200) {
      console.log("SIGNAL: stopping crawl now...");
      await crawler.serializeConfig();
      process.exit(0);
    }
    lastSigInt = Date.now();
  } catch (e) {
    console.log(e);
  }
}

process.on("SIGINT", async () => {
  console.log("SIGINT received...");
  await handleTerminate();
});

process.on("SIGUSR1", () => {
  crawler.finalExit = true;
});

process.on("SIGTERM", async () => {
  if (forceTerm || crawler.done) {
    console.log("SIGTERM received, exit immediately");
    process.exit(crawler.done ? 0 : 1);
  }

  console.log("SIGTERM received...");
  await handleTerminate();
});

process.on("SIGABRT", async () => {
  console.log("SIGABRT received, will force immediate exit on SIGTERM");
  forceTerm = true;
  crawler.exitCode = 1;
});



const { Crawler } = require("./crawler");

crawler = new Crawler();
crawler.run();


