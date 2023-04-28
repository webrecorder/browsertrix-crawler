import os from "os";

import { v4 as uuidv4 } from "uuid";

import { logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import { Recorder } from "./recorder.js";
import { rxEscape } from "./seeds.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 10;

// ===========================================================================
export function runWorkers(crawler, numWorkers, maxPageTime, collDir) {
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
    workers.push(new PageWorker(i + offset, crawler, maxPageTime, collDir));
  }

  return Promise.allSettled(workers.map((worker) => worker.run()));
}


// ===========================================================================
export class PageWorker
{
  constructor(id, crawler, maxPageTime, collDir) {
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

    this.recorder = new Recorder({workerid: id, collDir, crawler: this.crawler});
  }

  async closePage() {
    if (this.page) {

      if (!this.crashed) {
        await this.crawler.teardownPage(this.opts);
      } else {
        logger.debug("Closing crashed page", {workerid: this.id}, "worker");
      }

      if (this.recorder) {
        await this.recorder.onClosePage();
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
          this.crawler.browser.newWindowPageWithCDP(this.recorder),
          NEW_WINDOW_TIMEOUT,
          "New Window Timed Out",
          {workerid},
          "worker"
        );

        this.page = page;
        this.cdp = cdp;
        this.opts = {page: this.page, cdp: this.cdp, workerid};

        if (this.recorder) {
          await this.recorder.onCreatePage(this.opts);
        }

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

  async crawlPage(opts) {
    const res = await this.crawler.crawlPage(opts);
    if (this.recorder) {
      await this.recorder.finishPage();
    }
    return res;
  }

  async timedCrawlPage(opts) {
    const workerid = this.id;
    const { data } = opts;
    const { url } = data;

    logger.info("Starting page", {workerid, "page": url}, "worker");

    this.logDetails = {page: url, workerid};

    // set new page id
    const pageid = uuidv4();
    data.pageid = pageid;

    if (this.recorder) {
      this.recorder.startPage({pageid, url});
    }

    try {
      await Promise.race([
        timedRun(
          this.crawlPage(opts),
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
      logger.info("Worker done, all tasks complete", {workerid: this.id}, "worker");
    } catch (e) {
      logger.error("Worker errored", e, "worker");
    } finally {
      if (this.recorder) {
        await this.recorder.onDone();
      }
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


