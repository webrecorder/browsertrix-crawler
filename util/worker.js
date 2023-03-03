import { EventEmitter } from "node:events";
import PQueue from "p-queue";
import puppeteer from "puppeteer-core";

import { Logger, errJSON } from "./logger.js";

const logger = new Logger();

class BrowserEmitter extends EventEmitter {}
const browserEmitter = new BrowserEmitter();


// ===========================================================================
export class Worker
{
  constructor(id, browser, timeout, task, puppeteerOptions, screencaster) {
    this.id = id;
    this.browser = browser;
    this.timeout = timeout;
    this.task = task;
    this.puppeteerOptions = puppeteerOptions;
    this.screencaster = screencaster;
    
    this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);
  }

  async initPage(job) {
    //open page in a new tab
    this.pendingTargets = new Map();

    this.browser.on("targetcreated", (target) => {
      if (target.url() === this.startPage) {
        this.pendingTargets.set(target._targetId, target);
      }
    });

    try {
      const mainTarget = this.browser.target();
      this.cdp = await mainTarget.createCDPSession();
      let targetId;
      const res = await this.cdp.send("Target.createTarget", {url: this.startPage, newWindow: true});
      targetId = res.targetId;
      const target = this.pendingTargets.get(targetId);
      this.pendingTargets.delete(targetId);
      this.page = await target.page();
      this.page._workerid = this.id;
    } catch (err) {
      logger.warn("Error getting new page in window context", {"workerid": this.id, ...errJSON(err)}, "worker");
      this.repair(job);
    }
  }

  async runTask(job) {
    if (job.callbacks) {
      job.callbacks.start();
    }

    const urlData = job.data;
    await this.initPage(job);

    const url = job.getUrl();
    logger.info("Starting page", {"workerid": this.id, "page": url}, "worker");

    let result;
    let errorState;

    await this.task({
      page: this.page,
      data: urlData,
    });

    try {
      await this.page.close();
    } catch (e) {
      // ignore
    }

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

  repair(job) {
    logger.info("Starting repair", {workerid: this.id}, "worker");
    browserEmitter.emit("repair", this, job);
  }

  async shutdown() {
    logger.info("Shutting down browser", {workerid: this.id}, "worker");
    browserEmitter.emit("close");
  }
}


// ===========================================================================
export class WorkerPool
{
  constructor(options) {
    this.maxConcurrency = options.maxConcurrency;
    this.timeout = options.timeout;
    this.puppeteerOptions = options.puppeteerOptions;
    this.crawlState = options.crawlState;
    this.screencaster = options.screencaster;

    this.task = options.task;

    this.browser = null;

    this.workers = [];
    this.workersAvailable = [];
    this.workersBusy = [];

    this.errorCount = 0;
    this.interrupted = false;

    this.createWorkers(this.maxConcurrency);

    browserEmitter.on("repair", (worker, job) => {
      setImmediate(() => {
        if (!this.interrupted) {
          this.repair(worker, job);
        }
      });
    });

    browserEmitter.on("close", () => {
      this.close();
    });
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
      this.timeout,
      this.task,
      this.puppeteerOptions,
      this.screencaster
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
    await new Promise(resolve => setTimeout(resolve, 500));

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
      logger.info("No jobs available", {}, "worker");
      this.freeWorker(worker);
      return;
    }

    const result = await worker.runTask(job);

    if (result.type === "error") {
      if (job.callbacks) {
        job.callbacks.reject(result.error);
      }
      this.errorCount += 1;
    } else if (result.type === "success" && job.callbacks) {
      job.callbacks.resolve(result.data);
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
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await queue.onIdle();
  }

  interrupt() {
    logger.info("Interrupting Crawl", {}, "worker");
    this.interrupted = true;
  }

  async repair (worker, job) {
    if (this.screencaster) {
      this.screencaster.endAllTargets();
    }

    try {
      // will probably fail, but just in case the repair was not necessary
      await this.browser.close();
    /* eslint-disable no-empty */
    } catch (e) {}
    
    logger.info(`Re-launching job in worker ${worker.id} with repaired browser`, {}, "worker");
    this.browser = await puppeteer.launch(this.puppeteerOptions);
    await worker.runTask(job);
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



