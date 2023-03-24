import fsp from "fs/promises";
import path from "path";
import os from "os";

import PQueue from "p-queue";

import { logger, errJSON } from "./logger.js";
import { sleep, timedRun, timestampNow } from "./timing.js";

import { WARCRecord, WARCSerializer } from "warcio";

const MAX_REUSE = 5;

const NEW_WINDOW_TIMEOUT = 10;

// ===========================================================================
export function runWorkers(crawler, numWorkers, maxPageTime, archivesDir) {
  logger.info(`Creating ${numWorkers} workers`, {}, "worker");

  const workers = [];

  for (let i = 0; i < numWorkers; i++) {
    workers.push(new PageWorker(i, crawler, maxPageTime, archivesDir));
  }

  return Promise.allSettled(workers.map((worker) => worker.run()));
}


// ===========================================================================
export class PageWorker
{
  constructor(id, crawler, maxPageTime, archivesDir) {
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

    this.queue = new PQueue({concurrency: 1});
    this.initFH(archivesDir);
  }

  async initFH(archivesDir) {
    await fsp.mkdir(archivesDir, {recursive: true});
    const crawlId = process.env.CRAWL_ID || os.hostname();
    this.fh = await fsp.open(path.join(archivesDir, `rec-${crawlId}-${timestampNow()}-${this.id}.warc`), "a");
  }

  async closePage() {
    if (this.page) {

      if (!this.crashed) {
        await this.crawler.teardownPage(this.opts);
      } else {
        logger.debug("Closing crashed page", {workerid: this.id}, "worker");
      }

      if (this.queue) {
        try {
          await this.queue.onIdle();
        } catch (e) {
          // ignore
        }
      }

      await this.page.unroute("**/*");

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

        try {
          await this.onNewPage();
        } catch (e) {
          logger.warn("New Page Error", e, "worker");
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

  async onNewPage() {
    const cdp = this.cdp;

    cdp.on("Fetch.requestPaused", async (params) => {
      const { requestId } = params;

      let continued = false;

      try {
        continued = await this.handleRequestPaused(params);
      } catch (e) {
        logger.error("Error handling response, probably skpping URL", {...errJSON(e)}, "recorder");
      }

      if (!continued && this.cdp === cdp) {
        await cdp.send("Fetch.continueResponse", {requestId});
      }
    });

    await cdp.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Response"}]});
  }

  async handleRequestPaused(params) {
    let payload;

    if (params.responseErrorReason) {
      logger.warn("Skipping failed response", {url: params.request.url, reason: params.responseErrorReason}, "recorder");
      return false;
    }

    if (!this.fh) {
      return false;
    }

    if (params.responseStatusCode === 206 || (params.responseStatusCode >= 300 && params.responseStatusCode < 400)) {
      payload = new Uint8Array();
    } else {
      try {
        const { requestId } = params;
        const { body, base64Encoded} = await this.cdp.send("Fetch.getResponseBody", {requestId});
        payload = Buffer.from(body, base64Encoded ? "base64" : "utf-8");
      } catch (e) {
        logger.warn("Failed to load response body", {url: params.request.url, ...errJSON(e)}, "recorder");
        return false;
      }
    }

    const { request } = params;
    const { url } = request;

    if (await this.isDupeByUrl(url)) {
      logger.warn("Already crawled, skipping dupe", {url}, "record");
      return false;
    }

    const urlParsed = new URL(url);

    const warcVersion = "WARC/1.1";
    const date = new Date().toISOString();

    // response
    const createResponse = () => {
      const statusline = `HTTP/1.1 ${params.responseStatusCode} ${params.responseStatusText}`;

      const httpHeaders = {};
      for (const header of params.responseHeaders) {
        httpHeaders[header.name] = header.value;
      }

      return WARCRecord.create({
        url, date, warcVersion, type: "response",
        httpHeaders, statusline}, [payload]);
    };

    // request
    const createRequest = () => {
      const method = request.method;

      const statusline = `${method} ${url.slice(urlParsed.origin.length)} HTTP/1.1`;

      const requestBody = request.postData ? [request.postData] : [];

      return WARCRecord.create({
        url, date, warcVersion, type: "request",
        httpHeaders: request.headers, statusline}, requestBody);
    };

    const responseRecord = await createResponse();
    const requestRecord = await createRequest();

    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(responseRecord, {gzip: true})));
    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(requestRecord, {gzip: true})));

    return false;
  }

  //todo
  async isDupeByUrl(url) {
    return !await this.crawler.crawlState.redis.hsetnx("dedup:u", url, "1");
  }

  async onFinalize() {
    await this.queue.onIdle();

    const fh = this.fh;
    this.fh = null;

    if (fh) {
      await fh.sync();
      await fh.close();
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
      logger.info("Worker done, all tasks complete", {workerid: this.id}, "worker");
    } catch (e) {
      logger.error("Worker errored", e, "worker");
    } finally {
      await this.closePage();

      await this.onFinalize();
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


