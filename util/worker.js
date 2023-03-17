import { logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 10;

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

    this.failed = false;
    this.logDetails = {workerid: this.id};
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
    const workerid = this.id;

    while (true) {
      try {
        logger.debug("Getting page in new window", {workerid}, "worker");
        const { page, cdp } = await timedRun(
          this.crawler.browser.newWindowPageWithCDP(),
          NEW_WINDOW_TIMEOUT,
          "New Window Timed Out!",
          {workerid},
          "worker"
        );

        this.page = page;
        this.cdp = cdp;
        this.opts = {page: this.page, cdp: this.cdp, workerid};

        // updated per page crawl
        this.failed = false;
        this.logDetails = {page: this.page.url(), workerid};

        // more serious page crash, mark as failed
        this.page.on("crash", () => {
          logger.error("Page Crash", ...this.logDetails, "worker");
          this.failed = true;
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
    const url = opts.data.url;

    logger.info("Starting page", {workerid, "page": url}, "worker");

    this.logDetails = {page: url, workerid};

    this.failed = false;

    try {
      const result = await timedRun(
        this.crawler.crawlPage(opts),
        this.timeout,
        "Page Worker Timeout",
        {workerid},
        "worker"
      );

      this.failed = this.failed || !result;

    } catch (e) {
      logger.error("Worker Exception", {...errJSON(e), ...this.logDetails}, "worker");
      this.failed = true;
    } finally {
      if (this.failed) {
        logger.warn("Page Load Failed", this.logDetails, "worker");
        this.crawler.markPageFailed(url);
      }
    }

    return this.failed;
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


