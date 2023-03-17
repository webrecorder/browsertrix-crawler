//import PQueue from "p-queue";

import { Logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const logger = new Logger();

const MAX_REUSE = 5;



// ===========================================================================
export function runWorkers(crawler, numWorkers, timeout) {
  logger.info(`Creating ${numWorkers} workers`, {}, "worker");

  const workers = [];

  for (let i = 0; i < numWorkers; i++) {
    workers.push(new PageWorker(`worker-${i+1}`, crawler, timeout));
  }

  return Promise.allSettled(workers.map((worker) => worker.run()));
}


// ===========================================================================
export class PageWorker
{
  constructor(id, crawler, timeout) {
    this.id = id;
    this.crawler = crawler;
    this.timeout = timeout;

    this.reuseCount = 0;
    this.page = null;
    this.cdp = null; 

    this.opts = null;
  }

  async closePage() {
    if (this.page) {
      await this.crawler.teardownPage(this.opts);

      try {
        await this.cdp.detach();
      } catch (e) {
        // ignore
      }
      this.cdp = null;

      try {
        await this.page.close();
      } catch (e) {
        // ignore
      }
      this.page = null;
    }
  }

  async initPage() {
    if (this.page && ++this.reuseCount <= MAX_REUSE) {
      logger.debug("Reusing page", {reuseCount: this.reuseCount}, "worker");
      return this.opts;
    } else {
      await this.closePage();
    }
    
    this.reuseCount = 1;

    while (true) {
      try {
        this.page = await this.crawler.browserContext.newPage();
        this.page._workerid = this.id;

        this.cdp = await this.crawler.browserContext.newCDPSession(this.page);
        this.opts = {page: this.page, cdp: this.cdp, workerid: this.id};

        await this.crawler.setupPage(this.opts);

        return this.opts;

      } catch (err) {
        logger.warn("Error getting new page", {"workerid": this.id, ...errJSON(err)}, "worker");
        await sleep(0.5);
        logger.warn("Retry getting new page");

        if (this.healthChecker) {
          this.healthChecker.incError();
        }
      }
    }
  }

  async timedCrawlPage(opts) {
    const workerid = this.id;
    const url = opts.data.url;

    logger.info("Starting page", {workerid, "page": url}, "worker");

    const logDetails = {page: url, workerid};

    let failed = false;

    // more serious page error, mark page session as invalid
    this.page.on("pageerror", () => failed = true);

    try {
      const result = await timedRun(
        this.crawler.crawlPage(opts),
        this.timeout,
        "Page Worker Timeout",
        {workerid},
        "worker"
      );

      failed = failed || !result;

    } catch (e) {
      logger.error("Page Exception", {...errJSON(e), ...logDetails}, "worker");
      failed = true;
    } finally {
      if (failed) {
        logger.warn("Page Load Failed", logDetails, "worker");
        this.crawler.markPageFailed(url);
      }
    }

    return failed;
  }

  async run() {
    logger.info("Worker starting", {workerid: this.id}, "worker");

    try {
      await this.runLoop();
      logger.info("Worker exiting, all tasks complete", {workerid: this.id}, "worker");
    } catch (e) {
      logger.error("Worker errored", e, "worker");
    }
  }

  async runLoop() {
    const crawlState = this.crawler.crawlState;

    while (!this.crawler.interrupted) {
      const data = await crawlState.nextFromQueue();

      // see if any work data in the queue
      if (data) {
        // init page (new or reuse)
        const opts = await this.initPage();

        // run timed crawl of page
        const failed = await this.timedCrawlPage({...opts, data});

        // close page if failed
        if (failed) {
          logger.debug("Resetting failed page", {}, "worker");

          await this.closePage();
        }
      } else {

        // otherwise, see if any pending urls
        const pending = await crawlState.numPending();

        // if pending, sleep and check again
        if (pending) {
          logger.debug("No crawl tasks, but pending tasks remain, waiting", {pending, workerid: this.id}, "worker");
          await sleep(10);
        } else {
          // if no pending and queue size is still empty, we're done!
          if (!await crawlState.queueSize()) {
            break;
          }
        }
      }
    }
  }
}


