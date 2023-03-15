import PQueue from "p-queue";
import puppeteer from "puppeteer-core";

import { Logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const logger = new Logger();

const MAX_REUSE = 5;


// ===========================================================================
export class PageWorker
{
  constructor(id, browser, task, healthChecker) {
    this.id = id;
    this.browser = browser;
    this.task = task;
    this.healthChecker = healthChecker;

    this.reuseCount = 0;
    this.page = null;
    
    this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);
  }

  async closePage() {
    if (this.page) {
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
      return this.page;
    } else {
      await this.closePage();
    }
    //open page in a new tab
    this.pendingTargets = new Map();

    this.browser.on("targetcreated", (target) => {
      if (target.url() === this.startPage) {
        this.pendingTargets.set(target._targetId, target);
      }
    });

    this.reuseCount = 1;

    while (true) {
      try {
        logger.debug("Opening new page", {}, "worker");
        const mainTarget = this.browser.target();
        this.cdp = await mainTarget.createCDPSession();
        let targetId;
        const res = await this.cdp.send("Target.createTarget", {url: this.startPage, newWindow: true});
        targetId = res.targetId;
        const target = this.pendingTargets.get(targetId);
        this.pendingTargets.delete(targetId);
        this.page = await target.page();
        this.page._workerid = this.id;
        if (this.healthChecker) {
          this.healthChecker.resetErrors();
        }
        break;
      } catch (err) {
        logger.warn("Error getting new page in window context", {"workerid": this.id, ...errJSON(err)}, "worker");
        await sleep(0.5);
        logger.warn("Retry getting new page");

        if (this.healthChecker) {
          this.healthChecker.incError();
        }
      }
    }

    return this.page;
  }
}


// ===========================================================================
export class WorkerPool
{
  constructor(options) {
    this.maxConcurrency = options.maxConcurrency;
    this.puppeteerOptions = options.puppeteerOptions;
    this.crawlState = options.crawlState;
    this.healthChecker = options.healthChecker;
    this.totalTimeout = options.totalTimeout || 1e4;

    this.task = options.task;

    this.browser = null;

    this.workers = [];
    this.workersAvailable = [];
    this.workersBusy = [];

    this.interrupted = false;
    this.queue = null;

    this.inited = this.createWorkers(this.maxConcurrency);
  }

  async createWorkers(numWorkers = 1) {
    if (!this.browser) {
      this.browser = await puppeteer.launch(this.puppeteerOptions);
    }
    logger.info(`Creating ${numWorkers} workers`, {}, "worker");
    for (let i=0; i < numWorkers; i++) {
      this.createWorker(`worker-${i+1}`);
    }
  }

  createWorker(id) {
    const worker = new PageWorker(
      id,
      this.browser,
      this.task,
      this.healthChecker
    );
    this.workers.push(worker);
    this.workersAvailable.push(worker);
  }

  async getAvailableWorker() {
    if (this.workersAvailable.length > 0) {
      const worker = this.workersAvailable.shift();
      this.workersBusy.push(worker);
      return worker;
    }

    // wait half a second and try again
    logger.info("Waiting for available worker", {}, "worker");
    await sleep(0.5);

    return await this.getAvailableWorker();
    
  }

  freeWorker(worker) {
    const workerIndex = this.workersBusy.indexOf(worker);
    this.workersBusy.splice(workerIndex, 1);
    this.workersAvailable.push(worker);
  }

  async crawlPageInWorker() {
    const worker = await this.getAvailableWorker();

    const data = await this.crawlState.nextFromQueue();

    if (!data) {
      logger.debug("No crawl tasks available - waiting for pending pages to finish", {}, "worker");
      this.freeWorker(worker);
      return;
    }

    const { url } = data;

    const page = await worker.initPage();

    logger.info("Starting page", {"workerid": worker.id, "page": url}, "worker");

    const result = await timedRun(
      worker.task({ page, data }),
      this.totalTimeout,
      "Page Worker Timeout",
      {"workerid": worker.id},
      "worker"
    );

    if (!result) {
      logger.debug("Resetting failed page", {}, "worker");

      await worker.closePage();

      logger.warn("Page Load Failed", {url}, "worker");

      await this.crawlState.markFailed(url);

      // if (this.healthChecker) {
      //   this.healthChecker.incError();
      // }
    } else {
      // if (this.healthChecker) {
      //   this.healthChecker.resetErrors();
      // }

      await this.crawlState.markFinished(url);
    }

    this.freeWorker(worker);
  }

  async work() {
    logger.debug("Awaiting worker pool init", {}, "worker");
    await this.inited;

    this.queue = new PQueue({concurrency: this.maxConcurrency});

    while (!this.interrupted) {
      const size = await this.crawlState.queueSize();
      const pending = await this.crawlState.numPending();

      if (!(size + pending)) {
        break;
      }

      if (size > 0) {
        (async () => {
          await this.queue.add(() => this.crawlPageInWorker());
        })();
      }

      // wait half a second
      await sleep(0.5);
    }

    logger.debug("Finishing pending crawl tasks", {pending: this.queue.pending}, "worker");

    await this.queue.onIdle();

    logger.debug("Crawl tasks done", {}, "worker");
  }

  interrupt() {
    logger.info("Interrupting Crawl", {}, "worker");
    this.interrupted = true;
    this.queue.clear();
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      /* eslint-disable no-empty */
      } catch (e) {}
    }
  }
}


