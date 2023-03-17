import PQueue from "p-queue";

import { Logger, errJSON } from "./logger.js";
import { sleep, timedRun } from "./timing.js";

const logger = new Logger();

const MAX_REUSE = 5;


// ===========================================================================
export class PageWorker
{
  constructor(id, browserContext, crawlPage, healthChecker, screencaster) {
    this.id = id;
    this.browserContext = browserContext;
    this.crawlPage = crawlPage;
    this.healthChecker = healthChecker;
    this.screencaster = screencaster;

    this.reuseCount = 0;
    this.page = null;
    this.cdp = null;
    
    //this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);
  }

  async closePage() {
    if (this.page) {
      if (this.screencaster) {
        logger.debug("End Screencast", {workerid: this.id}, "screencast");
        await this.screencaster.stopById(this.id);
      }

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
      return this.page;
    } else {
      await this.closePage();
    }
    
    this.reuseCount = 1;

    while (true) {
      try {
        this.page = await this.browserContext.newPage();
        this.page._workerid = this.id;

        this.cdp = await this.browserContext.newCDPSession(this.page);

        await this.page.addInitScript("Object.defineProperty(navigator, \"webdriver\", {value: false});");

        //TODO: is this still needed?
        //await this.page.goto(this.startPage);

        if (this.healthChecker) {
          this.healthChecker.resetErrors();
        }

        if (this.screencaster) {
          logger.debug("Start Screencast", {workerid: this.id}, "screencast");
          await this.screencaster.screencastPage(this.page, this.id, this.cdp);
        }

        break;
      } catch (err) {
        logger.warn("Error getting new page", {"workerid": this.id, ...errJSON(err)}, "worker");
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
    this.browserContext = options.browserContext;
    this.maxConcurrency = options.maxConcurrency;
    this.crawlState = options.crawlState;
    this.healthChecker = options.healthChecker;
    this.totalTimeout = options.totalTimeout || 1e4;
    this.screencaster = options.screencaster;

    this.crawlPage = options.crawlPage;

    this.workers = [];
    this.workersAvailable = [];
    this.workersBusy = [];

    this.interrupted = false;
    this.queue = null;

    this.createWorkers(this.maxConcurrency);
  }

  createWorkers(numWorkers = 1) {
    logger.info(`Creating ${numWorkers} workers`, {}, "worker");
    for (let i=0; i < numWorkers; i++) {
      this.createWorker(`worker-${i+1}`);
    }
  }

  createWorker(id) {
    const worker = new PageWorker(
      id,
      this.browserContext,
      this.crawlPage,
      this.healthChecker,
      this.screencaster,
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
    const data = await this.crawlState.nextFromQueue();

    if (!data) {
      logger.debug("No crawl tasks available - waiting for pending pages to finish", {pending: this.queue.pending}, "worker");
      await sleep(10);
      return;
    }

    const worker = await this.getAvailableWorker();

    const { url } = data;

    const { page, cdp } = await worker.initPage();

    logger.info("Starting page", {"workerid": worker.id, "page": url}, "worker");

    const result = await timedRun(
      worker.crawlPage({ page, data, cdp }),
      this.totalTimeout,
      "Page Worker Timeout",
      {"workerid": worker.id},
      "worker"
    );

    if (!result || page.__failed) {
      logger.debug("Resetting failed page", {}, "worker");

      await worker.closePage();

      logger.warn("Page Load Failed", {url}, "worker");
    }

    this.freeWorker(worker);
  }

  async work() {
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
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      /* eslint-disable no-empty */
      } catch (e) {}
    }
  }
}


