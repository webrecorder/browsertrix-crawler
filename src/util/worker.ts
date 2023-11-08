import os from "os";

import { v4 as uuidv4 } from "uuid";

import { logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import { Recorder } from "./recorder.js";
import { rxEscape } from "./seeds.js";
import { CDPSession, Page } from "puppeteer-core";
import { PageState, WorkerId } from "./state.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 20;
const TEARDOWN_TIMEOUT = 10;
const FINISHED_TIMEOUT = 60;

// ===========================================================================
export function runWorkers(
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crawler: any,
  numWorkers: number,
  maxPageTime: number,
  collDir: string
) {
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
      offset = Number(m[1]) * numWorkers;
      logger.info("Starting workerid index at " + offset, "worker");
    }
  }

  for (let i = 0; i < numWorkers; i++) {
    workers.push(new PageWorker(i + offset, crawler, maxPageTime, collDir));
  }

  return Promise.allSettled(workers.map((worker) => worker.run()));
}

// ===========================================================================
// TODO: Fix this the next time the file is edited.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkerOpts = Record<string, any> & {
  page: Page;
  cdp: CDPSession;
  workerid: WorkerId;
  // eslint-disable-next-line @typescript-eslint/ban-types
  callbacks: Record<string, Function>;
  directFetchCapture?:
    | ((url: string) => Promise<{ fetched: boolean; mime: string }>)
    | null;
};

// ===========================================================================
export type WorkerState = WorkerOpts & {
  data: PageState;
};

// ===========================================================================
export class PageWorker {
  id: WorkerId;
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crawler: any;
  maxPageTime: number;

  reuseCount = 0;
  page?: Page | null;
  cdp?: CDPSession | null;

  // eslint-disable-next-line @typescript-eslint/ban-types
  callbacks?: Record<string, Function>;

  opts?: WorkerOpts;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logDetails: Record<string, any> = {};

  crashed = false;
  markCrashed?: (reason: string) => void;
  crashBreak?: Promise<void>;

  recorder: Recorder;

  constructor(
    id: WorkerId,
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    crawler: any,
    maxPageTime: number,
    collDir: string
  ) {
    this.id = id;
    this.crawler = crawler;
    this.maxPageTime = maxPageTime;

    this.logDetails = { workerid: this.id };

    this.recorder = new Recorder({
      workerid: id,
      collDir,
      crawler: this.crawler,
    });

    this.crawler.browser.recorders.push(this.recorder);
  }

  async closePage() {
    if (!this.page) {
      return;
    }

    if (this.recorder) {
      await this.recorder.onClosePage();
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
      logger.debug(
        "Closing page",
        { crashed: this.crashed, workerid: this.id },
        "worker"
      );
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

  isSameOrigin(url: string) {
    try {
      const currURL = new URL(this.page ? this.page.url() : "");
      const newURL = new URL(url);
      return currURL.origin === newURL.origin;
    } catch (e) {
      return false;
    }
  }

  async initPage(url: string): Promise<WorkerOpts> {
    if (
      !this.crashed &&
      this.page &&
      this.opts &&
      ++this.reuseCount <= MAX_REUSE &&
      this.isSameOrigin(url)
    ) {
      logger.debug(
        "Reusing page",
        { reuseCount: this.reuseCount, ...this.logDetails },
        "worker"
      );
      return this.opts;
    } else if (this.page) {
      await this.closePage();
    }

    this.reuseCount = 1;
    const workerid = this.id;

    let retry = 0;

    while (await this.crawler.isCrawlRunning()) {
      try {
        logger.debug("Getting page in new window", { workerid }, "worker");
        const result = await timedRun(
          this.crawler.browser.newWindowPageWithCDP(),
          NEW_WINDOW_TIMEOUT,
          "New Window Timed Out",
          { workerid },
          "worker"
        );

        if (!result) {
          throw new Error("timed out");
        }

        const { page, cdp } = result;

        this.page = page;
        this.cdp = cdp;
        this.callbacks = {};
        const directFetchCapture = this.recorder
          ? (x: string) => this.recorder.directFetchCapture(x)
          : null;
        this.opts = {
          page,
          cdp,
          workerid,
          callbacks: this.callbacks,
          directFetchCapture,
        };

        if (this.recorder) {
          await this.recorder.onCreatePage(this.opts);
        }

        // updated per page crawl
        this.crashed = false;
        this.crashBreak = new Promise(
          (resolve, reject) => (this.markCrashed = reject)
        );

        this.logDetails = { page: page.url(), workerid };

        // more serious page crash, mark as failed
        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.on("error", (err: any) => {
          // ensure we're still on this page, otherwise ignore!
          if (this.page === page) {
            logger.error(
              "Page Crashed",
              { ...errJSON(err), ...this.logDetails },
              "worker"
            );
            this.crashed = true;
            if (this.markCrashed) {
              this.markCrashed("crashed");
            }
          }
        });

        await this.crawler.setupPage(this.opts);

        return this.opts;
      } catch (err) {
        logger.warn(
          "Error getting new page",
          { workerid: this.id, ...errJSON(err) },
          "worker"
        );
        retry++;

        if (!this.crawler.browser.browser) {
          break;
        }

        if (retry >= MAX_REUSE) {
          logger.fatal(
            "Unable to get new page, browser likely crashed",
            this.logDetails,
            "worker"
          );
        }

        await sleep(0.5);
        logger.warn("Retrying getting new page", this.logDetails, "worker");

        if (this.crawler.healthChecker) {
          this.crawler.healthChecker.incError();
        }
      }
    }

    throw new Error("no page available, shouldn't get here");
  }

  async crawlPage(opts: WorkerState) {
    const res = await this.crawler.crawlPage(opts);
    if (this.recorder) {
      await this.recorder.finishPage();
    }
    return res;
  }

  async timedCrawlPage(opts: WorkerState) {
    const workerid = this.id;
    const { data } = opts;
    const { url } = data;

    logger.info("Starting page", { workerid, page: url }, "worker");

    this.logDetails = { page: url, workerid };

    // set new page id
    const pageid = uuidv4();
    data.pageid = pageid;

    if (this.recorder) {
      this.recorder.startPage({ pageid, url });
    }

    try {
      await Promise.race([
        timedRun(
          this.crawlPage(opts),
          this.maxPageTime,
          "Page Worker Timeout",
          this.logDetails,
          "worker"
        ),
        this.crashBreak,
      ]);
    } catch (e) {
      if (e instanceof Error && e.message !== "logged" && !this.crashed) {
        logger.error(
          "Worker Exception",
          { ...errJSON(e), ...this.logDetails },
          "worker"
        );
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
    logger.info("Worker starting", { workerid: this.id }, "worker");

    try {
      await this.runLoop();
      logger.info(
        "Worker done, all tasks complete",
        { workerid: this.id },
        "worker"
      );
    } catch (e) {
      logger.error(
        "Worker error, exiting",
        { ...errJSON(e), workerid: this.id },
        "worker"
      );
    } finally {
      if (this.recorder) {
        await this.recorder.onDone();
      }
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
        // filter out any out-of-scope pages right away
        if (!this.crawler.isInScope(data, this.logDetails)) {
          logger.info("Page no longer in scope", data);
          await crawlState.markExcluded(data.url);
          continue;
        }

        // init page (new or reuse)
        const opts = await this.initPage(data.url);

        // run timed crawl of page
        await this.timedCrawlPage({ ...opts, data });

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
            logger.debug(
              "No crawl tasks, but pending tasks remain, waiting",
              { pending, workerid: this.id },
              "worker"
            );
            loggedWaiting = true;
          }
          await sleep(0.5);
        } else {
          // if no pending and queue size is still empty, we're done!
          if (!(await crawlState.queueSize())) {
            break;
          }
        }
      }
    }
  }
}
