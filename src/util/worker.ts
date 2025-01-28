import os from "os";

import { logger, formatErr } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import { Recorder } from "./recorder.js";
import { rxEscape } from "./seeds.js";
import { CDPSession, Page } from "puppeteer-core";
import { PageState, WorkerId } from "./state.js";
import { Crawler } from "../crawler.js";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 20;
const TEARDOWN_TIMEOUT = 10;
const FINISHED_TIMEOUT = 60;

export type WorkerState = {
  page: Page;
  cdp: CDPSession;
  workerid: WorkerId;
  // eslint-disable-next-line @typescript-eslint/ban-types
  callbacks: Record<string, Function>;
  recorder: Recorder | null;
  markPageUsed: () => void;
  frameIdToExecId: Map<string, number>;
  isAuthSet?: boolean;
  pageBlockUnload?: boolean;
  data: PageState;
};

// ===========================================================================
export class PageWorker {
  id: WorkerId;

  crawler: Crawler;
  maxPageTime: number;

  reuseCount = 0;
  alwaysReuse: boolean;
  page?: Page | null;
  cdp?: CDPSession | null;

  // eslint-disable-next-line @typescript-eslint/ban-types
  callbacks?: Record<string, Function>;

  opts?: WorkerState;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logDetails: Record<string, any> = {};

  crashed = false;
  markCrashed?: (reason: string) => void;
  crashBreak?: Promise<void>;

  recorder: Recorder | null;

  constructor(
    id: WorkerId,
    crawler: Crawler,
    maxPageTime: number,
    alwaysReuse = false,
  ) {
    this.id = id;
    this.crawler = crawler;
    this.maxPageTime = maxPageTime;
    this.alwaysReuse = alwaysReuse;

    this.logDetails = { workerid: this.id };

    this.recorder = this.crawler.createRecorder(this.id);
  }

  async closePage() {
    if (!this.page) {
      return;
    }

    if (this.recorder) {
      await this.recorder.onClosePage();
    }

    if (!this.crashed && this.opts) {
      try {
        await timedRun(
          this.crawler.teardownPage(this.opts),
          TEARDOWN_TIMEOUT,
          "Page Teardown Timed Out",
          this.logDetails,
          "worker",
        );
      } catch (e) {
        // ignore
      }
    }

    try {
      logger.debug(
        "Closing page",
        { crashed: this.crashed, workerid: this.id },
        "worker",
      );
      await timedRun(
        this.page.close(),
        TEARDOWN_TIMEOUT,
        "Page Close Timed Out",
        this.logDetails,
        "worker",
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

  async initPage(pagestate: PageState): Promise<WorkerState> {
    const { url } = pagestate;
    let reuse = !this.crashed && !!this.opts && !!this.page;
    if (!this.alwaysReuse) {
      reuse = this.reuseCount <= MAX_REUSE && this.isSameOrigin(url);
    }
    if (reuse) {
      logger.debug(
        "Reusing page",
        { reuseCount: this.reuseCount, ...this.logDetails },
        "worker",
      );
      this.opts!.data = pagestate;
      return this.opts!;
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
          "worker",
        );

        if (!result) {
          throw new Error("timed out");
        }

        const { page, cdp } = result;

        this.page = page;
        this.cdp = cdp;
        this.callbacks = {};

        this.opts = {
          page,
          cdp,
          workerid,
          callbacks: this.callbacks,
          recorder: this.recorder,
          frameIdToExecId: new Map<string, number>(),
          markPageUsed: () => {
            if (!this.alwaysReuse) {
              this.reuseCount++;
            }
          },
          pageBlockUnload: false,
          data: pagestate,
        };

        if (this.recorder) {
          await this.recorder.onCreatePage(this.opts);
        }

        // updated per page crawl
        this.crashed = false;
        this.crashBreak = new Promise(
          (resolve, reject) => (this.markCrashed = reject),
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
              { ...formatErr(err), ...this.logDetails },
              "worker",
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
          { workerid: this.id, ...formatErr(err) },
          "worker",
        );
        retry++;

        if (!this.crawler.browser.browser) {
          break;
        }

        if (retry >= MAX_REUSE) {
          logger.fatal(
            "Unable to get new page, browser likely crashed",
            this.logDetails,
            "worker",
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
      await this.recorder.awaitPageResources();
    }
    return res;
  }

  async timedCrawlPage(opts: WorkerState) {
    const workerid = this.id;
    const { data } = opts;
    const { url, pageid } = data;

    logger.info("Starting page", { workerid, page: url }, "worker");

    this.logDetails = { page: url, workerid };

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
          "worker",
          true,
        ),
        this.crashBreak,
      ]);
    } catch (e) {
      if (e instanceof Error && e.message !== "logged" && !this.crashed) {
        logger.error(
          "Worker Exception",
          { ...formatErr(e), ...this.logDetails },
          "worker",
        );
      }

      await this.closePage();
    } finally {
      try {
        if (this.recorder) {
          opts.data.ts = this.recorder.writePageInfoRecord();
        }
      } catch (e) {
        logger.error(
          "Error writing pageinfo recorder",
          { ...formatErr(e), ...this.logDetails },
          "recorder",
        );
      }

      await timedRun(
        this.crawler.pageFinished(data),
        FINISHED_TIMEOUT,
        "Page Finished Timed Out",
        this.logDetails,
        "worker",
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
        "worker",
      );
    } catch (e) {
      logger.error(
        "Worker error, exiting",
        { ...formatErr(e), workerid: this.id },
        "worker",
      );
    }
  }

  async finalize(waitTime?: number) {
    if (this.recorder) {
      await this.recorder.onDone(waitTime ?? this.maxPageTime);
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
        if (!(await this.crawler.isInScope(data, this.logDetails))) {
          logger.info("Page no longer in scope", data);
          await crawlState.markExcluded(data.url);
          continue;
        }

        // init page (new or reuse)
        const opts = await this.initPage(data);

        // run timed crawl of page
        await this.timedCrawlPage(opts);

        loggedWaiting = false;
      } else {
        // indicate that the worker has no more work (mostly for screencasting, status, etc...)
        // depending on other works, will either get more work or crawl will end
        await this.crawler.workerIdle(this.id);

        // check if any pending urls
        const pending = await crawlState.numPending();

        // if pending, sleep and check again
        if (pending) {
          if (!loggedWaiting) {
            logger.debug(
              "No crawl tasks, but pending tasks remain, waiting",
              { pending, workerid: this.id },
              "worker",
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

// ===========================================================================
const workers: PageWorker[] = [];

// ===========================================================================
export async function runWorkers(
  crawler: Crawler,
  numWorkers: number,
  maxPageTime: number,
  alwaysReuse = false,
) {
  logger.info(`Creating ${numWorkers} workers`, {}, "worker");

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
    workers.push(new PageWorker(i + offset, crawler, maxPageTime, alwaysReuse));
  }

  await Promise.allSettled(workers.map((worker) => worker.run()));

  await closeWorkers();

  await crawler.browser.close();
}

// ===========================================================================
export function closeWorkers(waitTime?: number) {
  return Promise.allSettled(workers.map((worker) => worker.finalize(waitTime)));
}
