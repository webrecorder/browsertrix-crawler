#!/usr/bin/env node

var crawler = null;

var lastSigInt = 0;

process.on("SIGINT", async () => {
  if (crawler) {
    try {
      if (!crawler.crawlState.draining) {
        console.log("SIGINT received, gracefully finishing current pages...");
        crawler.cluster.allTargetCount -= (await crawler.crawlState.size());
        crawler.crawlState.setDrain();
      } else if ((Date.now() - lastSigInt) > 200) {
        console.log("SIGINT received, aborting crawl...");
        await crawler.serializeConfig();
        process.exit(1);
      }
      lastSigInt = Date.now();
    } catch (e) {
      console.log(e);
    }
  }
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, exiting");
});



const { Crawler } = require("./crawler");

crawler = new Crawler();
crawler.run();


