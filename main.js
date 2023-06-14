#!/usr/bin/env -S node --experimental-global-webcrypto

import { logger } from "./util/logger.js";
import { setExitOnRedisError } from "./util/redis.js";
import { Crawler } from "./crawler.js";
import express from "express";
import bodyParser from "body-parser";

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

  setExitOnRedisError(true);

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

const app = express();
const port = 3000;

app.use(bodyParser.json());

app.post("/crawl", (req, res) => {
  const reqDict = { ...req.body };
  const requiredKeys = ["url", "collection", "id"];
  const missingKeys = requiredKeys.filter((key) => !(key in reqDict));
  if (missingKeys.length === 0) {
    process.argv.push("--url", reqDict.url, "--collection", reqDict.collection, "--id", String(reqDict.id));
    res.status(200).send(`${reqDict.url} enqueued to crawl`);
    crawler = new Crawler();
    crawler.run();
  } else {
    res.status(404).send("Ensure that url, collection and id is present as keys in json");
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
