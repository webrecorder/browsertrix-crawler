//import { EventEmitter } from "node:events";
import PQueue from "p-queue";

import { Logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const logger = new Logger();

//class BrowserEmitter extends EventEmitter {}
//const browserEmitter = new BrowserEmitter();

const MAX_REUSE = 5;


// ===========================================================================
export class Worker
{
  constructor(id, browser, task, healthChecker, emulateDevice) {
    this.id = id;
    this.browser = browser;
    this.task = task;
    this.healthChecker = healthChecker;
    this.emulateDevice = emulateDevice;

    this.reuseCount = 0;
    this.context = null;
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
    
    this.reuseCount = 1;

    while (true) {
      try {
        if (!this.context) {
          if (this.emulateDevice) {
            this.context = await this.browser.newContext({...this.emulateDevice});
          } else {
            this.context = await this.browser.newContext();
          }
        }
        this.page = await this.context.newPage();
        await this.page.goto(this.startPage);
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
  }

  async runTask(job) {
    if (job.callbacks) {
      job.callbacks.start();
    }

    const urlData = job.data;

    await this.initPage();

    const url = job.getUrl();

    logger.info("Starting page", {"workerid": this.id, "page": url}, "worker");

    return await this.task({
      browserContext: this.context,
      page: this.page,
      data: urlData,
    });
  }
}


// ===========================================================================
export class WorkerPool
{
  constructor(options) {
    this.browserCls = options.browserCls;
    this.maxConcurrency = options.maxConcurrency;
    this.playwrightOptions = options.playwrightOptions;
    this.emulateDevice = options.emulateDevice;
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
      this.browser = await this.browserCls.launch(this.playwrightOptions);
    }
    logger.info(`Creating ${numWorkers} workers`, {}, "worker");
    for (let i=0; i < numWorkers; i++) {
      this.createWorker(`worker-${i+1}`);
    }
  }

  createWorker(id) {
    const worker = new Worker(
      id,
      this.browser,
      this.task,
      this.healthChecker,
      this.emulateDevice,
    );
    this.workers.push(worker);
    this.workersAvailable.push(worker);
  }

  async getAvailableWorker() {
    if (this.workersAvailable.length > 0) {
      const worker = this.workersAvailable.shift();
      this.workersBusy.push(worker);
      logger.debug(`Using available worker ${worker.id}`);
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
    const job = await this.crawlState.shift();

    if (!job) {
      logger.debug("No jobs available - waiting for pending pages to finish", {}, "worker");
      await sleep(2);
      return;
    }

    const worker = await this.getAvailableWorker();

    const result = await timedRun(
      worker.runTask(job),
      this.totalTimeout,
      "Page Worker Timeout",
      {"workerid": worker.id},
      "worker"
    );

    if (!result) {
      logger.debug("Resetting failed page", {}, "worker");

      await worker.closePage();

      if (job.callbacks) {
        logger.debug("Calling job reject callback", {job}, "worker");
        job.callbacks.reject("timed out");
      }
      // if (this.healthChecker) {
      //   this.healthChecker.incError();
      // }
    } else {
      // if (this.healthChecker) {
      //   this.healthChecker.resetErrors();
      // }

      if (job.callbacks) {
        logger.debug("Calling job resolve callback", {job}, "worker");
        job.callbacks.resolve(result);
      }
    }

    this.freeWorker(worker);
  }

  async work() {
    logger.debug("Awaiting worker pool init", {}, "worker");
    await this.inited;

    this.queue = new PQueue({concurrency: this.maxConcurrency});

    while (!this.interrupted) {
      if ((await this.crawlState.realSize()) + (await this.crawlState.numPending()) == 0) {
        break;
      }

      if ((await this.crawlState.realSize()) > 0) {
        (async () => {
          await this.queue.add(() => this.crawlPageInWorker());
        })();
      }

      // wait half a second
      await sleep(0.5);
    }

    logger.debug("Awaiting queue onIdle()", {}, "worker");
    await this.queue.onIdle();
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


