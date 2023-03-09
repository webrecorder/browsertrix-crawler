//import { EventEmitter } from "node:events";
import PQueue from "p-queue";
import puppeteer from "puppeteer-core";

import { Logger, errJSON } from "./logger.js";

const logger = new Logger();

//class BrowserEmitter extends EventEmitter {}
//const browserEmitter = new BrowserEmitter();

const MAX_REUSE = 5;


// ===========================================================================
export class Worker
{
  constructor(id, browser, task, puppeteerOptions, screencaster, healthChecker) {
    this.id = id;
    this.browser = browser;
    this.task = task;
    this.puppeteerOptions = puppeteerOptions;
    this.screencaster = screencaster;
    this.healthChecker = healthChecker;

    this.reuseCount = 0;
    this.page = null;
    
    this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);
  }

  async initPage() {
    if (this.page && ++this.reuseCount <= MAX_REUSE) {
      logger.debug("Reusing page", {reuseCount: this.reuseCount}, "worker");
      return this.page;
    } else if (this.page) {
      try {
        await this.page.close();
      } catch (e) {
        // ignore
      }
      this.page = null;
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
        await sleep(500);
        logger.warn("Retry getting new page");

        if (this.healthChecker) {
          this.healthChecker.incError();
        }
      }
    }
  }

  async runTask(job) {
    if (job.callbacks) {
      job.callbacks.start();
    }

    const urlData = job.data;

    await this.initPage();

    const url = job.getUrl();

    logger.info("Starting page", {"workerid": this.id, "page": url}, "worker");

    let result;
    let errorState;

    await this.task({
      page: this.page,
      data: urlData,
    });

    if (errorState) {
      return {
        type: "error",
        error: errorState,
      };
    }

    return {
      data: result,
      type: "success",
    };
  }
}


// ===========================================================================
export class WorkerPool
{
  constructor(options) {
    this.maxConcurrency = options.maxConcurrency;
    this.puppeteerOptions = options.puppeteerOptions;
    this.crawlState = options.crawlState;
    this.screencaster = options.screencaster;
    this.healthChecker = options.healthChecker;

    this.task = options.task;

    this.browser = null;

    this.workers = [];
    this.workersAvailable = [];
    this.workersBusy = [];

    this.interrupted = false;

    this.createWorkers(this.maxConcurrency);
  }

  async createWorkers(numWorkers = 1) {
    if (!this.browser) {
      this.browser = await puppeteer.launch(this.puppeteerOptions);
    }
    logger.info(`Creating ${numWorkers} workers`, {}, "worker");
    for (let i=0; i < numWorkers; i++) {
      await this.createWorker(`worker-${i+1}`);
    }
  }

  async createWorker(id) {
    const worker = new Worker(
      id,
      this.browser,
      this.task,
      this.puppeteerOptions,
      this.screencaster,
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
    await sleep(500);

    return await this.getAvailableWorker();
    
  }

  freeWorker(worker) {
    const workerIndex = this.workersBusy.indexOf(worker);
    this.workersBusy.splice(workerIndex, 1);
    this.workersAvailable.push(worker);
  }

  async crawlPageInWorker() {
    const worker = await this.getAvailableWorker();

    const job = await this.crawlState.shift();

    if (!job) {
      logger.debug("No jobs available - waiting for pending pages to finish", {}, "worker");
      this.freeWorker(worker);
      return;
    }

    const result = await worker.runTask(job);

    if (result.type === "error") {
      if (job.callbacks) {
        job.callbacks.reject(result.error);
      }
      if (this.healthChecker) {
        this.healthChecker.incError();
      }
    } else if (result.type === "success") {
      if (this.healthChecker) {
        this.healthChecker.resetErrors();
      }

      if (job.callbacks) {
        job.callbacks.resolve(result.data);
      }
    }

    this.freeWorker(worker);
  }

  async work() {
    const queue = new PQueue({concurrency: this.maxConcurrency});

    while (!this.interrupted) {
      if ((await this.crawlState.realSize()) + (await this.crawlState.numPending()) == 0) {
        break;
      }

      if ((await this.crawlState.realSize()) > 0) {
        (async () => {
          await queue.add(() => this.crawlPageInWorker());
        })();
      }

      // wait half a second
      await sleep(500);
    }

    await queue.onIdle();
  }

  interrupt() {
    logger.info("Interrupting Crawl", {}, "worker");
    this.interrupted = true;
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

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

