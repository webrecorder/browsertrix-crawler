import os from "os";
import { logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import { rxEscape } from "./seeds.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 20;
const TEARDOWN_TIMEOUT = 10;
const FINISHED_TIMEOUT = 60;

// ===========================================================================
export function runWorkers(crawler, numWorkers, maxPageTime) {
  logger.info(`Creating ${numWorkers} workers`, {}, "worker");

  const workers = [];
  let offset = 0;

  // automatically set worker start by ordinal in k8s
  // if hostname is "crawl-id-name-N"
  // while CRAWL_ID is "crawl-id-name", then set starting
  // worker index offset to N * numWorkers

  if (process.env.CRAWL_ID) {
    const rx = new RegExp(rxEscape(process.env.CRAWL_ID) + "\\-([\\d]+)$");
    const m = os.hostname().match(rx);
    if (m) {
      offset = m[1] * numWorkers;
      logger.info("Starting workerid index at " + offset, "worker");
    }
  }

  for (let i = 0; i < numWorkers; i++) {
    //workers.push(new PageWorker(`worker-${i+1}`, crawler, maxPageTime));
    workers.push(new PageWorker(i + offset, crawler, maxPageTime));
  }

  return Promise.allSettled(workers.map((worker) => worker.run()));
}


// ===========================================================================
export class PageWorker
{
  constructor(id, crawler, maxPageTime) {
    this.id = id;
    this.crawler = crawler;
    this.maxPageTime = maxPageTime;

    this.reuseCount = 0;
    this.page = null;
    this.cdp = null; 
    this.callbacks = null;

    this.opts = null;

    this.logDetails = {workerid: this.id};

    this.crashed = false;
    this.markCrashed = null;
    this.crashBreak = null;
  }

  async closePage() {
    if (!this.page) {
      return;
    }

    if (!this.crashed) {
      try {
        await timedRun(
          this.crawler.teardownPage(this.opts),
          TEARDOWN_TIMEOUT,
          "Page Teardown Timed Out",
          this.logDetails,
          "worker"
        );
      } catch (e) {
        // ignore
      }
    }

    try {
      logger.debug("Closing page", {crashed: this.crashed, workerid: this.id}, "worker");
      await timedRun(
        this.page.close(),
        TEARDOWN_TIMEOUT,
        "Page Close Timed Out",
        this.logDetails,
        "worker"
      );
    } catch (e) {
      // ignore
    } finally {
      this.cdp = null;
      this.page = null;
    }
  }

  isSameOrigin(url) {
    try {
      const currURL = new URL(this.page.url());
      const newURL = new URL(url);
      return currURL.origin === newURL.origin;
    } catch (e) {
      return false;
    }
  }

  async initPage(url) {
    if (!this.crashed && this.page && ++this.reuseCount <= MAX_REUSE && this.isSameOrigin(url)) {
      logger.debug("Reusing page", {reuseCount: this.reuseCount, ...this.logDetails}, "worker");
      return this.opts;
    } else if (this.page) {
      await this.closePage();
    }
    
    this.reuseCount = 1;
    const workerid = this.id;

    let retry = 0;

    while (await this.crawler.isCrawlRunning()) {
      try {
        logger.debug("Getting page in new window", {workerid}, "worker");
        const result = await timedRun(
          this.crawler.browser.newWindowPageWithCDP(),
          NEW_WINDOW_TIMEOUT,
          "New Window Timed Out",
          {workerid},
          "worker"
        );

        if (!result) {
          throw new Error("timed out");
        }

        const { page, cdp } = result;

        this.page = page;
        this.cdp = cdp;
        this.callbacks = {};
        this.opts = {page: this.page, cdp: this.cdp, workerid, callbacks: this.callbacks};

        // updated per page crawl
        this.crashed = false;
        this.crashBreak = new Promise((resolve, reject) => this.markCrashed = reject);

        this.logDetails = {page: this.page.url(), workerid};

        // more serious page crash, mark as failed
        this.page.on("error", (err) => {
          // ensure we're still on this page, otherwise ignore!
          if (this.page === page) {
            logger.error("Page Crashed", {...errJSON(err), ...this.logDetails}, "worker");
            this.crashed = true;
            this.markCrashed("crashed");
          }
        });

        await this.crawler.setupPage(this.opts);

        return this.opts;

      } catch (err) {
        logger.warn("Error getting new page", {"workerid": this.id, ...errJSON(err)}, "worker");
        retry++;

        if (!this.crawler.browser.browser) {
          break;
        }      

        if (retry >= MAX_REUSE) {
          logger.fatal("Unable to get new page, browser likely crashed", this.logDetails, "worker");
        }

        await sleep(0.5);
        logger.warn("Retrying getting new page", this.logDetails, "worker");

        if (this.crawler.healthChecker) {
          this.crawler.healthChecker.incError();
        }
      }
    }
  }

  async timedCrawlPage(opts) {
    const workerid = this.id;
    const { data } = opts;
    const { url } = data;

    logger.info("Starting page", {workerid, "page": url}, "worker");

    this.logDetails = {page: url, workerid};

    try {
      await Promise.race([
        timedRun(
          this.crawler.crawlPage(opts),
          this.maxPageTime,
          "Page Worker Timeout",
          this.logDetails,
          "worker"
        ),
        this.crashBreak
      ]);

    } catch (e) {
      if (e.message !== "logged" && !this.crashed) {
        logger.error("Worker Exception", {...errJSON(e), ...this.logDetails}, "worker");
      }
    } finally {
      await timedRun(
        this.crawler.pageFinished(data),
        FINISHED_TIMEOUT,
        "Page Finished Timed Out",
        this.logDetails,
        "worker"
      );
    }
  }

  async run() {
    logger.info("Worker starting", {workerid: this.id}, "worker");

    try {
      await this.runLoop();
      logger.info("Worker exiting, all tasks complete", {workerid: this.id}, "worker");
    } catch (e) {
      logger.error("Worker error, exiting", {...errJSON(e), workerid: this.id}, "worker");
    }
  }

  async runLoop() {
    const crawlState = this.crawler.crawlState;

    let loggedWaiting = false;

    while (await this.crawler.isCrawlRunning()) {
      await crawlState.processMessage(this.crawler.params.scopedSeeds);

      const data = await crawlState.nextFromQueue();

      // see if any work data in the queue
      if (data) {
        // init page (new or reuse)
        const opts = await this.initPage(data.url);

        // run timed crawl of page
        await this.timedCrawlPage({...opts, data});

        loggedWaiting = false;

      } else {
        // indicate that the worker has no more work (mostly for screencasting, status, etc...)
        // depending on other works, will either get more work or crawl will end
        this.crawler.workerIdle(this.id);

        // check if any pending urls
        const pending = await crawlState.numPending();

        // if pending, sleep and check again
        if (pending) {
          if (!loggedWaiting) {
            logger.debug("No crawl tasks, but pending tasks remain, waiting", {pending, workerid: this.id}, "worker");
            loggedWaiting = true;
          }
          await sleep(0.5);
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


