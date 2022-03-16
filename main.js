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
      crawler.crawlState.setDrain();

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

process.on("SIGTERM", async () => {
  if (forceTerm) {
    console.log("SIGTERM received, exit immediately");
    process.exit(3);
  }

  console.log("SIGTERM received...");
  await handleTerminate();
});

process.on("SIGABRT", async () => {
  console.log("SIGABRT received, will force immediate exit on SIGTERM");
  forceTerm = true;
});



const { Crawler } = require("./crawler");

crawler = new Crawler();
crawler.run();


