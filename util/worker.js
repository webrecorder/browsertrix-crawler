import { logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 10;

// ===========================================================================
export function runWorkers(crawler, numWorkers, maxPageTime) {
  logger.info(`Creating ${numWorkers} workers`, {}, "worker");

  const workers = [];

  for (let i = 0; i < numWorkers; i++) {
    //workers.push(new PageWorker(`worker-${i+1}`, crawler, maxPageTime));
    workers.push(new PageWorker(i, crawler, maxPageTime));
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

    this.opts = null;

    this.logDetails = {workerid: this.id};

    this.crashed = false;
    this.markCrashed = null;
    this.crashBreak = null;
  }

  async closePage() {
    if (this.page) {

      if (!this.crashed) {
        await this.crawler.teardownPage(this.opts);
      } else {
        logger.debug("Closing crashed page", {workerid: this.id}, "worker");
      }

      try {
        await this.page.close();
      } catch (e) {
        // ignore
      }

      if (this.crashed) {
        const numPagesRemaining = this.crawler.browser.numPages() - 1;
        logger.debug("Skipping teardown of crashed page", {numPagesRemaining, workerid: this.id}, "worker");
      }

      this.cdp = null;
      this.page = null;
    }
  }

  async initPage() {
    if (!this.crashed && this.page && ++this.reuseCount <= MAX_REUSE) {
      logger.debug("Reusing page", {reuseCount: this.reuseCount}, "worker");
      return this.opts;
    } else if (this.page) {
      await this.closePage();
    }
    
    this.reuseCount = 1;
    const workerid = this.id;

    while (true) {
      try {
        logger.debug("Getting page in new window", {workerid}, "worker");
        const { page, cdp } = await timedRun(
          this.crawler.browser.newWindowPageWithCDP(),
          NEW_WINDOW_TIMEOUT,
          "New Window Timed Out",
          {workerid},
          "worker"
        );

        this.page = page;
        this.cdp = cdp;
        this.opts = {page: this.page, cdp: this.cdp, workerid};

        // updated per page crawl
        this.crashed = false;
        this.crashBreak = new Promise((resolve, reject) => this.markCrashed = reject);

        this.logDetails = {page: this.page.url(), workerid};

        // more serious page crash, mark as failed
        this.page.on("crash", (details) => {
          logger.error("Page Crash", {details, ...this.logDetails}, "worker");
          this.crashed = true;
          this.markCrashed("crashed");
        });

        await this.crawler.setupPage(this.opts);

        return this.opts;

      } catch (err) {
        logger.warn("Error getting new page", {"workerid": this.id, ...errJSON(err)}, "worker");
        await sleep(0.5);
        logger.warn("Retry getting new page");

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
          {workerid},
          "worker"
        ),
        this.crashBreak
      ]);

    } catch (e) {
      logger.error("Worker Exception", {...errJSON(e), ...this.logDetails}, "worker");
    } finally {
      await this.crawler.pageFinished(data);
    }
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
        await this.timedCrawlPage({...opts, data});

      } else {
        // indicate that the worker has no more work (mostly for screencasting, status, etc...)
        // depending on other works, will either get more work or crawl will end
        this.crawler.workerIdle(this.id);

        // check if any pending urls
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


