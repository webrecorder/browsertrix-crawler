import child_process from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import fsp from "fs/promises";

import { RedisCrawlState, LoadState } from "./util/state.js";
import Sitemapper from "sitemapper";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

import * as warcio from "warcio";

import { HealthChecker } from "./util/healthcheck.js";
import { TextExtract } from "./util/textextract.js";
import { initStorage, getFileSize, getDirSize, interpolateFilename } from "./util/storage.js";
import { ScreenCaster, WSTransport, RedisPubSubTransport } from "./util/screencaster.js";
import { Screenshots } from "./util/screenshots.js";
import { parseArgs } from "./util/argParser.js";
import { initRedis } from "./util/redis.js";
import { logger, errJSON } from "./util/logger.js";
import { runWorkers } from "./util/worker.js";
import { sleep, timedRun, secondsElapsed } from "./util/timing.js";

import { Browser } from "./util/browser.js";

import { BEHAVIOR_LOG_FUNC, HTML_TYPES, DEFAULT_SELECTORS } from "./util/constants.js";

import { AdBlockRules, BlockRules } from "./util/blockrules.js";

// to ignore HTTPS error for HEAD check
import { Agent as HTTPAgent } from "http";
import { Agent as HTTPSAgent } from "https";

const HTTPS_AGENT = HTTPSAgent({
  rejectUnauthorized: false,
});

const HTTP_AGENT = HTTPAgent();

const behaviors = fs.readFileSync(new URL("./node_modules/browsertrix-behaviors/dist/behaviors.js", import.meta.url), {encoding: "utf8"});

const FETCH_TIMEOUT_SECS = 30;
const PAGE_OP_TIMEOUT_SECS = 5;


// ============================================================================
export class Crawler {
  constructor() {
    const res = parseArgs();
    this.params = res.parsed;
    this.origConfig = res.origConfig;

    // root collections dir
    this.collDir = path.join(this.params.cwd, "collections", this.params.collection);
    this.logDir = path.join(this.collDir, "logs");
    this.logFilename = path.join(this.logDir, `crawl-${new Date().toISOString().replace(/[^\d]/g, "")}.log`);

    const debugLogging = this.params.logging.includes("debug");
    logger.setDebugLogging(debugLogging);

    logger.debug("Writing log to: " + this.logFilename, {}, "init");

    this.headers = {};
    this.crawlState = null;

    // pages file
    this.pagesFH = null;

    this.crawlId = process.env.CRAWL_ID || os.hostname();

    this.startTime = Date.now();

    // was the limit hit?
    this.limitHit = false;

    this.saveStateFiles = [];
    this.lastSaveTime = 0;

    // sum of page load + behavior timeouts + 2 x fetch + cloudflare + link extraction timeouts + extra page delay
    // if exceeded, will interrupt and move on to next page (likely behaviors or some other operation is stuck)
    this.maxPageTime = this.params.pageLoadTimeout + this.params.behaviorTimeout +
                       FETCH_TIMEOUT_SECS*2 + PAGE_OP_TIMEOUT_SECS*2 + this.params.pageExtraDelay;

    this.emulateDevice = this.params.emulateDevice || {};

    this.captureBasePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/${this.params.collection}/record`;
    this.capturePrefix = process.env.NO_PROXY ? "" : this.captureBasePrefix + "/id_/";

    this.gotoOpts = {
      waitUntil: this.params.waitUntil,
      timeout: this.params.pageLoadTimeout * 1000
    };

    // pages directory
    this.pagesDir = path.join(this.collDir, "pages");

    // pages file
    this.pagesFile = path.join(this.pagesDir, "pages.jsonl");

    this.blockRules = null;
    this.adBlockRules = null;

    this.healthChecker = null;

    this.interrupted = false;
    this.finalExit = false;
    this.clearOnExit = false;

    this.done = false;

    this.behaviorLastLine = null;

    this.browser = new Browser();
  }

  configureUA() {
    // override userAgent
    if (this.params.userAgent) {
      this.emulateDevice.userAgent = this.params.userAgent;
      return;
    }

    // if device set, it overrides the default Chrome UA
    if (!this.emulateDevice.userAgent) {
      this.emulateDevice.userAgent = this.browser.getDefaultUA();
    }

    // suffix to append to default userAgent
    if (this.params.userAgentSuffix) {
      this.emulateDevice.userAgent += " " + this.params.userAgentSuffix;
    }

    return this.emulateDevice.userAgent;
  }

  async initCrawlState() {
    const redisUrl = this.params.redisStoreUrl || "redis://localhost:6379/0";

    if (!redisUrl.startsWith("redis://")) {
      logger.fatal("stateStoreUrl must start with redis:// -- Only redis-based store currently supported");
    }

    let redis;

    while (true) {
      try {
        redis = await initRedis(redisUrl);
        break;
      } catch (e) {
        //logger.fatal("Unable to connect to state store Redis: " + redisUrl);
        logger.warn(`Waiting for redis at ${redisUrl}`, {}, "state");
        await sleep(3);
      }
    }

    logger.debug(`Storing state via Redis ${redisUrl} @ key prefix "${this.crawlId}"`, {}, "state");

    logger.debug(`Max Page Time: ${this.maxPageTime} seconds`, {}, "state");

    this.crawlState = new RedisCrawlState(redis, this.params.crawlId, this.maxPageTime, os.hostname());

    if (this.params.saveState === "always" && this.params.saveStateInterval) {
      logger.debug(`Saving crawl state every ${this.params.saveStateInterval} seconds, keeping last ${this.params.saveStateHistory} states`, {}, "state");
    }

    return this.crawlState;
  }

  initScreenCaster() {
    let transport;

    if (this.params.screencastPort) {
      transport = new WSTransport(this.params.screencastPort);
      logger.debug(`Screencast server started on: ${this.params.screencastPort}`, {}, "screencast");
    } else if (this.params.redisStoreUrl && this.params.screencastRedis) {
      transport = new RedisPubSubTransport(this.params.redisStoreUrl, this.crawlId);
      logger.debug("Screencast enabled via redis pubsub", {}, "screencast");
    }

    if (!transport) {
      return null;
    }

    return new ScreenCaster(transport, this.params.workers);
  }

  async bootstrap() {
    const initRes = child_process.spawnSync("wb-manager", ["init", this.params.collection], {cwd: this.params.cwd});

    if (initRes.status) {
      logger.info("wb-manager init failed, collection likely already exists");
    }

    fs.mkdirSync(this.logDir, {recursive: true});
    this.logFH = fs.createWriteStream(this.logFilename);
    logger.setExternalLogStream(this.logFH);

    this.infoString = await this.getInfoString();
    logger.info(this.infoString);

    logger.info("Seeds", this.params.scopedSeeds);

    if (this.params.profile) {
      logger.info("With Browser Profile", {url: this.params.profile});
    }

    if (this.params.overwrite) {
      logger.debug(`Clearing ${this.collDir} before starting`);
      try {
        fs.rmSync(this.collDir, { recursive: true, force: true });
      } catch(e) {
        logger.error(`Unable to clear ${this.collDir}`, e);
      }
    }

    let opts = {};
    let redisStdio;

    if (this.params.logging.includes("pywb")) {
      const pywbStderr = fs.openSync(path.join(this.logDir, "pywb.log"), "a");
      const stdio = [process.stdin, pywbStderr, pywbStderr];

      const redisStderr = fs.openSync(path.join(this.logDir, "redis.log"), "a");
      redisStdio = [process.stdin, redisStderr, redisStderr];

      opts = {stdio, cwd: this.params.cwd};
    } else {
      opts = {stdio: "ignore", cwd: this.params.cwd};
      redisStdio = "ignore";
    }

    this.headers = {"User-Agent": this.configureUA()};

    const subprocesses = [];

    subprocesses.push(child_process.spawn("redis-server", {cwd: "/tmp/", stdio: redisStdio}));

    opts.env = {...process.env, COLL: this.params.collection, ROLLOVER_SIZE: this.params.rolloverSize};

    subprocesses.push(child_process.spawn("uwsgi", [new URL("uwsgi.ini", import.meta.url).pathname], opts));

    process.on("exit", () => {
      for (const proc of subprocesses) {
        proc.kill();
      }
    });

    child_process.spawn("socat", ["tcp-listen:9222,fork", "tcp:localhost:9221"]);

    if (!this.params.headless && !process.env.NO_XVFB) {
      child_process.spawn("Xvfb", [
        process.env.DISPLAY,
        "-listen",
        "tcp",
        "-screen",
        "0",
        process.env.GEOMETRY,
        "-ac",
        "+extension",
        "RANDR"
      ]);
    }
  }

  extraChromeArgs() {
    const args = [];
    if (this.params.lang) {
      args.push(`--accept-lang=${this.params.lang}`);
    }
    return args;
  }

  async run() {
    await this.bootstrap();

    let status;
    let exitCode = 0;

    try {
      await this.crawl();
      status = (!this.interrupted ? "done" : "interrupted");
    } catch(e) {
      logger.error("Crawl failed", e);
      exitCode = 9;
      status = "failing";
      if (await this.crawlState.incFailCount()) {
        status = "failed";
      }

    } finally {
      logger.info(`Crawl status: ${status}`);

      if (this.crawlState) {
        await this.crawlState.setStatus(status);
      }

      process.exit(exitCode);
    }
  }

  _behaviorLog({data, type}, pageUrl, workerid) {
    let behaviorLine;
    let message;
    let details;

    const logDetails = {page: pageUrl, workerid};

    if (typeof(data) === "string") {
      message = data;
      details = logDetails;
    } else {
      message = type === "info" ? "Behavior log" : "Behavior debug";
      details = typeof(data) === "object" ? {...data, ...logDetails} : logDetails;
    }

    switch (type) {
    case "info":
      behaviorLine = JSON.stringify(data);
      if (behaviorLine != this._behaviorLastLine) {
        logger.info(message, details, "behaviorScript");
        this._behaviorLastLine = behaviorLine;
      }
      break;

    case "debug":
    default:
      logger.debug(message, details, "behaviorScript");
    }
  }

  isInScope({seedId, url, depth, extraHops} = {}, logDetails = {}) {
    const seed = this.params.scopedSeeds[seedId];

    return seed.isIncluded(url, depth, extraHops, logDetails);
  }

  async setupPage({page, cdp, workerid}) {
    await page.addInitScript("Object.defineProperty(navigator, \"webdriver\", {value: false});");

    if (this.params.logging.includes("jserrors")) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          logger.warn(msg.text(), {"location": msg.location(), "page": page.url(), workerid}, "jsError");
        }
      });

      page.on("pageerror", (e) => {
        logger.warn("Page Error", {...errJSON(e), "page": page.url(), workerid}, "jsError");
      });
    }

    if (this.screencaster) {
      logger.debug("Start Screencast", {workerid}, "screencast");
      await this.screencaster.screencastPage(page, cdp, workerid);
    }

    if (this.params.behaviorOpts) {
      await page.exposeFunction(BEHAVIOR_LOG_FUNC, (logdata) => this._behaviorLog(logdata, page.url(), workerid));
      await page.addInitScript(behaviors + `;\nself.__bx_behaviors.init(${this.params.behaviorOpts});`);
    }
  }

  async crawlPage(opts) {
    await this.writeStats();

    const {page, cdp, data, workerid} = opts;

    const {url} = data;

    const logDetails = {page: url, workerid};
    data.logDetails = logDetails;
    data.workerid = workerid;

    if (!this.isInScope(data, logDetails)) {
      logger.info("Page no longer in scope", data);
      return true;
    }

    // run custom driver here
    await this.driver({page, data, crawler: this});

    data.title = await page.title();

    if (this.params.screenshot) {
      if (!data.isHTMLPage) {
        logger.debug("Skipping screenshots for non-HTML page", logDetails);
      }
      const archiveDir = path.join(this.collDir, "archive");
      const screenshots = new Screenshots({page, url, directory: archiveDir});
      if (this.params.screenshot.includes("view")) {
        await screenshots.take();
      }
      if (this.params.screenshot.includes("fullPage")) {
        await screenshots.takeFullPage();
      }
      if (this.params.screenshot.includes("thumbnail")) {
        await screenshots.takeThumbnail();
      }
    }

    if (this.params.text && data.isHTMLPage) {
      const result = await cdp.send("DOM.getDocument", {"depth": -1, "pierce": true});
      data.text = await new TextExtract(result).parseTextFromDom();
    }

    data.loadState = LoadState.EXTRACTION_DONE;

    if (this.params.behaviorOpts) {
      if (!data.isHTMLPage) {
        logger.debug("Skipping behaviors for non-HTML page", logDetails, "behavior");
      } else if (data.skipBehaviors) {
        logger.info("Skipping behaviors for slow page", logDetails, "behavior");
      } else {
        const res = await timedRun(
          this.runBehaviors(page, data.filteredFrames, logDetails),
          this.params.behaviorTimeout,
          "Behaviors timed out",
          logDetails,
          "behavior"
        );

        if (res && res.length) {
          logger.info("Behaviors finished", {finished: res.length, ...logDetails}, "behavior");
          data.loadState = LoadState.BEHAVIORS_DONE;
        }
      }
    }

    if (this.params.pageExtraDelay) {
      logger.info(`Waiting ${this.params.pageExtraDelay} seconds before moving on to next page`, logDetails);
      await sleep(this.params.pageExtraDelay);
    }

    return true;
  }

  async pageFinished(data) {
    await this.writePage(data);

    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      logger.info("Page Finished", {loadState, ...logDetails}, "pageStatus");

      await this.crawlState.markFinished(data.url);

      if (this.healthChecker) {
        this.healthChecker.resetErrors();
      }
    } else {
      logger.warn("Page Load Failed", {loadState, ...logDetails}, "pageStatus");

      await this.crawlState.markFailed(data.url);

      if (this.healthChecker) {
        this.healthChecker.incError();
      }
    }

    await this.serializeConfig();

    await this.checkLimits();
  }

  async teardownPage({workerid}) {
    if (this.screencaster) {
      await this.screencaster.stopById(workerid);
    }
  }

  async workerIdle(workerid) {
    if (this.screencaster) {
      //logger.debug("End Screencast", {workerid}, "screencast");
      await this.screencaster.stopById(workerid, true);
    }
  }

  async runBehaviors(page, frames, logDetails) {
    try {
      frames = frames || page.frames();

      const context = page.context();

      logger.info("Running behaviors", {frames: frames.length, frameUrls: frames.map(frame => frame.url()), ...logDetails}, "behavior");

      return await Promise.allSettled(
        frames.map(frame => this.browser.evaluateWithCLI(context, frame, "self.__bx_behaviors.run();", logDetails, "behavior"))
      );

    } catch (e) {
      logger.warn("Behavior run failed", {...errJSON(e), ...logDetails}, "behavior");
      return null;
    }
  }

  async shouldIncludeFrame(frame, logDetails) {
    if (!frame.parentFrame()) {
      return frame;
    }

    const frameUrl = frame.url();

    const frameElem = await frame.frameElement();

    const tagName = await frame.evaluate(e => e.tagName, frameElem);

    if (tagName !== "IFRAME" && tagName !== "FRAME") {
      logger.debug("Skipping processing non-frame object", {tagName, frameUrl, ...logDetails}, "behavior");
      return null;
    }

    let res;

    if (frameUrl === "about:blank") {
      res = false;
    } else {
      res = !this.adBlockRules.isAdUrl(frameUrl);
    }

    if (!res) {
      logger.debug("Skipping processing frame", {frameUrl, ...logDetails}, "behavior");
    }

    return res ? frame : null;
  }

  async getInfoString() {
    const packageFileJSON = JSON.parse(await fsp.readFile("../app/package.json"));
    const warcioPackageJSON = JSON.parse(await fsp.readFile("/app/node_modules/warcio/package.json"));
    const pywbVersion = child_process.execSync("pywb -V", {encoding: "utf8"}).trim().split(" ")[1];

    return `Browsertrix-Crawler ${packageFileJSON.version} (with warcio.js ${warcioPackageJSON.version} pywb ${pywbVersion})`;
  }

  async createWARCInfo(filename) {
    const warcVersion = "WARC/1.0";
    const type = "warcinfo";

    const info = {
      "software": this.infoString,
      "format": "WARC File Format 1.0"
    };

    const warcInfo = {...info, ...this.params.warcInfo, };
    const record = await warcio.WARCRecord.createWARCInfo({filename, type, warcVersion}, warcInfo);
    const buffer = await warcio.WARCSerializer.serialize(record, {gzip: true});
    return buffer;
  }

  async checkLimits() {
    let interrupt = false;

    if (this.params.sizeLimit) {
      const dir = path.join(this.collDir, "archive");

      const size = await getDirSize(dir);

      if (size >= this.params.sizeLimit) {
        logger.info(`Size threshold reached ${size} >= ${this.params.sizeLimit}, stopping`);
        interrupt = true;
        this.clearOnExit = true;
      }
    }

    if (this.params.timeLimit) {
      const elapsed = secondsElapsed(this.startTime);
      if (elapsed >= this.params.timeLimit) {
        logger.info(`Time threshold reached ${elapsed} > ${this.params.timeLimit}, stopping`);
        interrupt = true;
      }
    }

    if (interrupt) {
      this.gracefulFinish();
    }
  }

  gracefulFinish() {
    this.interrupted = true;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (!this.params.waitOnDone) {
      this.finalExit = true;
    }
  }

  prepareForExit(markDone = true) {
    if (!markDone) {
      this.params.waitOnDone = false;
      this.clearOnExit = true;
      logger.info("SIGNAL: Preparing for exit of this crawler instance only");
    } else {
      logger.info("SIGNAL: Preparing for final exit of all crawlers");
      this.finalExit = true;
    }
  }

  async serializeAndExit() {
    await this.serializeConfig();
    process.exit(0);
  }

  async crawl() {
    this.profileDir = await this.browser.loadProfile(this.params.profile);

    if (this.params.healthCheckPort) {
      this.healthChecker = new HealthChecker(this.params.healthCheckPort, this.params.workers);
    }

    try {
      const driverUrl = new URL(this.params.driver, import.meta.url);
      this.driver = (await import(driverUrl)).default;
    } catch(e) {
      logger.warn(`Error importing driver ${this.params.driver}`, e);
      return;
    }

    await this.initCrawlState();

    let initState = await this.crawlState.getStatus();

    while (initState === "debug") {
      logger.info("Paused for debugging, will continue after manual resume");

      await sleep(60);

      initState = await this.crawlState.getStatus();
    }

    // if already done, don't crawl anymore
    if (initState === "done") {
      this.done = true;

      if (this.params.waitOnDone) {
        logger.info("Already done, waiting for signal to exit...");

        // wait forever until signal
        await new Promise(() => {});
      }

      return;
    }

    if (this.params.generateWACZ) {
      this.storage = initStorage();
    }

    if (initState === "finalize") {
      await this.postCrawl();
      return;
    }

    await this.crawlState.setStatus("running");

    if (this.params.state) {
      await this.crawlState.load(this.params.state, this.params.scopedSeeds, true);
    }

    await this.initPages();

    this.adBlockRules = new AdBlockRules(this.captureBasePrefix, this.params.adBlockMessage, logger);

    if (this.params.blockRules && this.params.blockRules.length) {
      this.blockRules = new BlockRules(this.params.blockRules, this.captureBasePrefix, this.params.blockMessage, logger);
    }

    this.screencaster = this.initScreenCaster();

    for (let i = 0; i < this.params.scopedSeeds.length; i++) {
      const seed = this.params.scopedSeeds[i];
      if (!await this.queueUrl(i, seed.url, 0, 0)) {
        if (this.limitHit) {
          break;
        }
      }

      if (seed.sitemap) {
        await this.parseSitemap(seed.sitemap, i);
      }
    }

    await this.browser.launch({
      dataDir: this.profileDir,
      headless: this.params.headless,
      emulateDevice: this.emulateDevice,
      chromeOptions: {
        proxy: !process.env.NO_PROXY,
        userAgent: this.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs()
      }
    });

    // --------------
    // Run Crawl Here!
    await runWorkers(this, this.params.workers, this.maxPageTime);
    // --------------

    await this.serializeConfig(true);

    await this.browser.close();

    if (this.pagesFH) {
      await this.pagesFH.sync();
      await this.pagesFH.close();
    }

    await this.writeStats(true);

    // extra wait for all resources to land into WARCs
    await this.awaitPendingClear();

    await this.postCrawl();
  }

  async postCrawl() {
    if (this.params.combineWARC) {
      await this.combineWARC();
    }

    if (this.params.generateCDX) {
      logger.info("Generating CDX");
      await this.awaitProcess(child_process.spawn("wb-manager", ["reindex", this.params.collection], {cwd: this.params.cwd}));
    }

    await this.closeLog();

    if (this.params.generateWACZ && (!this.interrupted || this.finalExit || this.clearOnExit)) {
      await this.generateWACZ();

      if (this.clearOnExit) {
        logger.info(`Clearing ${this.collDir} before exit`);
        try {
          fs.rmSync(this.collDir, { recursive: true, force: true });
        } catch(e) {
          logger.warn(`Unable to clear ${this.collDir} before exit`, e);
        }
      }
    }

    if (this.params.waitOnDone && (!this.interrupted || this.finalExit)) {
      this.done = true;
      logger.info("All done, waiting for signal...");
      await this.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  async closeLog() {
    // close file-based log
    logger.setExternalLogStream(null);
    try {
      await new Promise(resolve => this.logFH.close(() => resolve()));
    } catch (e) {
      // ignore
    }
  }

  async generateWACZ() {
    logger.info("Generating WACZ");

    const archiveDir = path.join(this.collDir, "archive");

    // Get a list of the warcs inside
    const warcFileList = await fsp.readdir(archiveDir);

    // is finished (>0 pages and all pages written)
    const isFinished = await this.crawlState.isFinished();

    logger.info(`Num WARC Files: ${warcFileList.length}`);
    if (!warcFileList.length) {
      // if finished, just return
      if (isFinished) {
        return;
      }
      logger.fatal("No WARC Files, assuming crawl failed");
    }

    // Build the argument list to pass to the wacz create command
    const waczFilename = this.params.collection.concat(".wacz");
    const waczPath = path.join(this.collDir, waczFilename);

    const createArgs = [
      "create",
      "--split-seeds",
      "-o", waczPath,
      "--pages", this.pagesFile,
      "--log-directory", this.logDir
    ];

    if (process.env.WACZ_SIGN_URL) {
      createArgs.push("--signing-url");
      createArgs.push(process.env.WACZ_SIGN_URL);
      if (process.env.WACZ_SIGN_TOKEN) {
        createArgs.push("--signing-token");
        createArgs.push(process.env.WACZ_SIGN_TOKEN);
      }
    }

    createArgs.push("-f");

    warcFileList.forEach((val, index) => createArgs.push(path.join(archiveDir, val))); // eslint-disable-line  no-unused-vars

    // create WACZ
    const waczResult = await this.awaitProcess(child_process.spawn("wacz" , createArgs));

    if (waczResult !== 0) {
      logger.error("Error creating WACZ", {"status code": waczResult});
      logger.fatal("Unable to write WACZ successfully");
    }

    logger.debug(`WACZ successfully generated and saved to: ${waczPath}`);

    // Verify WACZ
    /*
    const validateArgs = ["validate"];
    validateArgs.push("-f");
    validateArgs.push(waczPath);

    const waczVerifyResult = await this.awaitProcess(child_process.spawn("wacz", validateArgs));

    if (waczVerifyResult !== 0) {
      console.log("validate", waczVerifyResult);
      logger.fatal("Unable to verify WACZ created successfully");
    }
*/
    if (this.storage) {
      const filename = process.env.STORE_FILENAME || "@ts-@id.wacz";
      const targetFilename = interpolateFilename(filename, this.crawlId);

      await this.storage.uploadCollWACZ(waczPath, targetFilename, isFinished);
    }
  }

  awaitProcess(proc) {
    proc.stdout.on("data", (data) => {
      logger.debug(data.toString());
    });

    proc.stderr.on("data", (data) => {
      logger.error(data.toString());
    });
    return new Promise((resolve) => {
      proc.on("close", (code) => resolve(code));
    });
  }

  async writeStats(toFile=false) {
    if (!this.params.logging.includes("stats")) {
      return;
    }

    const realSize = await this.crawlState.queueSize();
    const pendingList = await this.crawlState.getPendingList();
    const done = await this.crawlState.numDone();
    const total = realSize + pendingList.length + done;
    const limit = {max: this.params.limit || 0, hit: this.limitHit};
    const stats = {
      "crawled": done,
      "total": total,
      "pending": pendingList.length,
      "limit": limit,
      "pendingPages": pendingList.map(x => JSON.stringify(x))
    };

    logger.info("Crawl statistics", stats, "crawlStatus");

    if (toFile && this.params.statsFilename) {
      try {
        await fsp.writeFile(this.params.statsFilename, JSON.stringify(stats, null, 2));
      } catch (err) {
        logger.warn("Stats output failed", err);
      }
    }
  }

  async loadPage(page, data, selectorOptsList = DEFAULT_SELECTORS) {
    const {url, seedId, depth, extraHops = 0} = data;

    const logDetails = data.logDetails;

    let isHTMLPage = await timedRun(
      this.isHTML(url),
      FETCH_TIMEOUT_SECS,
      "HEAD request to determine if URL is HTML page timed out",
      logDetails
    );

    if (!isHTMLPage) {
      try {
        const captureResult = await timedRun(
          this.directFetchCapture(url),
          FETCH_TIMEOUT_SECS,
          "Direct fetch capture attempt timed out",
          logDetails
        );
        if (captureResult) {
          logger.info("Direct fetch successful", {url, ...logDetails}, "fetch");
          return;
        }
      } catch (e) {
        // ignore failed direct fetch attempt, do browser-based capture
      }
    }

    if (this.adBlockRules && this.params.blockAds) {
      await this.adBlockRules.initPage(page);
    }

    if (this.blockRules) {
      await this.blockRules.initPage(page);
    }

    let ignoreAbort = false;

    // Detect if ERR_ABORTED is actually caused by trying to load a non-page (eg. downloadable PDF),
    // if so, don't report as an error
    page.once("requestfailed", (req) => {
      ignoreAbort = shouldIgnoreAbort(req);
    });

    if (isHTMLPage) {
      page.once("domcontentloaded", () => {
        data.loadState = LoadState.CONTENT_LOADED;
      });
    }

    const gotoOpts = isHTMLPage ? this.gotoOpts : {waitUntil: "domcontentloaded"};

    logger.info("Awaiting page load", logDetails);

    try {
      const resp = await page.goto(url, gotoOpts);

      const contentType = await resp.headerValue("content-type");

      isHTMLPage = this.isHTMLContentType(contentType);

    } catch (e) {
      let msg = e.message || "";
      if (!msg.startsWith("net::ERR_ABORTED") || !ignoreAbort) {
        if (e.name === "TimeoutError") {
          if (data.loadState !== LoadState.CONTENT_LOADED) {
            logger.error("Page Load Timeout, skipping page", {msg, ...logDetails});
            throw e;
          } else {
            logger.warn("Page Loading Slowly, skipping behaviors", {msg, ...logDetails});
            data.skipBehaviors = true;
          }
        } else {
          logger.error("Page Load Error, skipping page", {msg, ...logDetails});
          throw e;
        }
      }
    }

    data.loadState = LoadState.FULL_PAGE_LOADED;

    data.isHTMLPage = isHTMLPage;

    if (isHTMLPage) {
      let frames = await page.frames();
      frames = await Promise.allSettled(frames.map((frame) => this.shouldIncludeFrame(frame, logDetails)));

      data.filteredFrames = frames.filter((x) => x.status === "fulfilled" && x.value).map(x => x.value);

      //data.filteredFrames = await page.frames().filter(frame => this.shouldIncludeFrame(frame, logDetails));
    } else {
      data.filteredFrames = [];
    }

    if (!isHTMLPage) {
      logger.debug("Skipping link extraction for non-HTML page", logDetails);
      return;
    }

    const seed = this.params.scopedSeeds[seedId];

    await this.checkCF(page, logDetails);

    await this.netIdle(page, logDetails);

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(depth) || !selectorOptsList) {
      return;
    }

    logger.debug("Extracting links");

    for (const opts of selectorOptsList) {
      const links = await this.extractLinks(page, data.filteredFrames, opts, logDetails);
      await this.queueInScopeUrls(seedId, links, depth, extraHops, logDetails);
    }
  }

  async netIdle(page, details) {
    if (!this.params.netIdleWait) {
      return;
    }
    // in case page starts loading via fetch/xhr immediately after page load,
    // we want to ensure we don't exit too early
    await sleep(0.5);

    try {
      await page.waitForLoadState("networkidle", {timeout: this.params.netIdleWait * 1000});
    } catch (e) {
      logger.debug("waitForNetworkIdle timed out, ignoring", details);
      // ignore, continue
    }
  }

  async extractLinks(page, frames, {selector = "a[href]", extract = "href", isAttribute = false} = {}, logDetails) {
    const results = [];

    const loadProp = (options) => {
      const { selector, extract } = options;
      return [...document.querySelectorAll(selector)].map(elem => elem[extract]);
    };

    const loadAttr = (options) => {
      const { selector, extract } = options;
      return [...document.querySelectorAll(selector)].map(elem => elem.getAttribute(extract));
    };

    const loadFunc = isAttribute ? loadAttr : loadProp;

    frames = frames || page.frames();

    try {
      const linkResults = await Promise.allSettled(
        frames.map(frame => timedRun(
          frame.evaluate(loadFunc, {selector: selector, extract: extract}),
          PAGE_OP_TIMEOUT_SECS,
          "Link extraction timed out",
          logDetails,
        ))
      );

      if (linkResults) {
        let i = 0;
        for (const linkResult of linkResults) {
          if (!linkResult) {
            logger.warn("Link Extraction timed out in frame", {frameUrl: frames[i].url, ...logDetails});
            continue;
          }
          if (!linkResult.value) continue;
          for (const link of linkResult.value) {
            results.push(link);
          }
          i++;
        }
      }

    } catch (e) {
      logger.warn("Link Extraction failed", e);
    }
    return results;
  }

  async queueInScopeUrls(seedId, urls, depth, extraHops = 0, logDetails = {}) {
    try {
      depth += 1;

      // new number of extra hops, set if this hop is out-of-scope (oos)
      const newExtraHops = extraHops + 1;

      for (const possibleUrl of urls) {
        const res = this.isInScope({url: possibleUrl, extraHops: newExtraHops, depth, seedId}, logDetails);

        if (!res) {
          continue;
        }

        const {url, isOOS} = res;

        if (url) {
          await this.queueUrl(seedId, url, depth, isOOS ? newExtraHops : extraHops);
        }
      }
    } catch (e) {
      logger.error("Queuing Error", e);
    }
  }

  async checkCF(page, logDetails) {
    try {
      logger.debug("Check CF Blocking", logDetails);

      const cloudflare = page.locator("div.cf-browser-verification.cf-im-under-attack");

      while (await cloudflare.waitFor({timeout: PAGE_OP_TIMEOUT_SECS})) {
        logger.debug("Cloudflare Check Detected, waiting for reload...", logDetails);
        await sleep(5.5);
      }
    } catch (e) {
      //logger.warn("Check CF failed, ignoring");
    }
  }

  async queueUrl(seedId, url, depth, extraHops = 0) {
    logger.debug(`Queuing url ${url}`);
    if (this.limitHit) {
      return false;
    }

    if (this.params.limit > 0 && (await this.crawlState.numSeen() >= this.params.limit)) {
      this.limitHit = true;
      return false;
    }

    if (await this.crawlState.has(url)) {
      return false;
    }

    //await this.crawlState.add(url);
    await this.crawlState.addToQueue({url, seedId, depth, extraHops});
    return true;
  }

  async initPages() {
    try {
      let createNew = false;

      // create pages dir if doesn't exist and write pages.jsonl header
      if (fs.existsSync(this.pagesDir) != true){
        await fsp.mkdir(this.pagesDir);
        createNew = true;
      }

      this.pagesFH = await fsp.open(this.pagesFile, "a");

      if (createNew) {
        const header = {"format": "json-pages-1.0", "id": "pages", "title": "All Pages"};
        if (this.params.text) {
          header["hasText"] = true;
          logger.debug("Text Extraction: Enabled");
        } else {
          header["hasText"] = false;
          logger.debug("Text Extraction: Disabled");
        }
        const header_formatted = JSON.stringify(header).concat("\n");
        await this.pagesFH.writeFile(header_formatted);
      }

    } catch(err) {
      logger.error("pages/pages.jsonl creation failed", err);
    }
  }

  async writePage({url, depth, title, text, loadState}) {
    const id = uuidv4();
    const row = {id, url, title, loadState};

    if (depth === 0) {
      row.seed = true;
    }

    if (text !== null) {
      row.text = text;
    }

    const processedRow = JSON.stringify(row) + "\n";
    try {
      await this.pagesFH.writeFile(processedRow);
    } catch (err) {
      logger.warn("pages/pages.jsonl append failed", err);
    }
  }

  resolveAgent(urlParsed) {
    return urlParsed.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
  }

  async isHTML(url) {
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        headers: this.headers,
        agent: this.resolveAgent
      });
      if (resp.status !== 200) {
        logger.debug(`Skipping HEAD check ${url}, invalid status ${resp.status}`);
        return true;
      }

      return this.isHTMLContentType(resp.headers.get("Content-Type"));

    } catch(e) {
      // can't confirm not html, so try in browser
      logger.debug("HEAD request failed", {...e, url});
      return true;
    }
  }

  isHTMLContentType(contentType) {
    // just load if no content-type
    if (!contentType) {
      return true;
    }

    const mime = contentType.split(";")[0];

    if (HTML_TYPES.includes(mime)) {
      return true;
    }

    return false;
  }

  async directFetchCapture(url) {
    const abort = new AbortController();
    const signal = abort.signal;
    const resp = await fetch(this.capturePrefix + url, {signal, headers: this.headers, redirect: "manual"});
    abort.abort();
    return resp.status === 200 && !resp.headers.get("set-cookie");
  }

  async awaitPendingClear() {
    logger.info("Waiting to ensure pending data is written to WARCs...");

    const redis = await initRedis("redis://localhost/0");

    while (!this.interrupted) {
      try {
        const count = Number(await redis.get(`pywb:${this.params.collection}:pending`) || 0);
        if (count <= 0) {
          break;
        }
        logger.debug("Waiting for pending requests to finish", {numRequests: count});
      } catch (e) {
        break;
      }

      await sleep(1);
    }
  }

  async parseSitemap(url, seedId) {
    const sitemapper = new Sitemapper({
      url,
      timeout: 15000,
      requestHeaders: this.headers
    });

    try {
      const { sites } = await sitemapper.fetch();
      await this.queueInScopeUrls(seedId, sites, 0);
    } catch(e) {
      logger.warn("Error fetching sites from sitemap", e);
    }
  }

  async combineWARC() {
    logger.info("Generating Combined WARCs");

    // Get the list of created Warcs
    const warcLists = await fsp.readdir(path.join(this.collDir, "archive"));

    logger.debug(`Combining ${warcLists.length} WARCs...`);

    const fileSizeObjects = []; // Used to sort the created warc by fileSize

    // Go through a list of the created works and create an array sorted by their filesize with the largest file first.
    for (let i = 0; i < warcLists.length; i++) {
      const fileName = path.join(this.collDir, "archive", warcLists[i]);
      const fileSize = await getFileSize(fileName);
      fileSizeObjects.push({"fileSize": fileSize, "fileName": fileName});
      fileSizeObjects.sort((a, b) => b.fileSize - a.fileSize);
    }

    const generatedCombinedWarcs = [];

    // Used to name combined warcs, default to -1 for first increment
    let combinedWarcNumber = -1;

    // write combine WARC to collection root
    let combinedWarcFullPath = "";

    // fileHandler
    let fh = null;

    // Iterate through the sorted file size array.
    for (let j = 0; j < fileSizeObjects.length; j++) {

      // if need to rollover to new warc
      let doRollover = false;

      // set to true for first warc
      if (combinedWarcNumber < 0) {
        doRollover = true;
      } else {
        // Check the size of the existing combined warc.
        const currentCombinedWarcSize = await getFileSize(combinedWarcFullPath);

        //  If adding the current warc to the existing combined file creates a file smaller than the rollover size add the data to the combinedWarc
        const proposedWarcSize = fileSizeObjects[j].fileSize + currentCombinedWarcSize;

        doRollover = (proposedWarcSize >= this.params.rolloverSize);
      }

      if (doRollover) {
        // If adding the current warc to the existing combined file creates a file larger than the rollover size do the following:
        // 1. increment the combinedWarcNumber
        // 2. create the name of the new combinedWarcFile
        // 3. Write the header out to the new file
        // 4. Write out the current warc data to the combinedFile
        combinedWarcNumber = combinedWarcNumber + 1;

        const combinedWarcName = `${this.params.collection}_${combinedWarcNumber}.warc.gz`;

        // write combined warcs to root collection dir as they're output of a collection (like wacz)
        combinedWarcFullPath = path.join(this.collDir, combinedWarcName);

        if (fh) {
          fh.end();
        }

        fh = fs.createWriteStream(combinedWarcFullPath, {flags: "a"});

        generatedCombinedWarcs.push(combinedWarcName);

        const warcBuffer = await this.createWARCInfo(combinedWarcName);
        fh.write(warcBuffer);
      }

      logger.debug(`Appending WARC ${fileSizeObjects[j].fileName}`);

      const reader = fs.createReadStream(fileSizeObjects[j].fileName);

      const p = new Promise((resolve) => {
        reader.on("end", () => resolve());
      });

      reader.pipe(fh, {end: false});

      await p;
    }

    if (fh) {
      await fh.end();
    }

    logger.debug(`Combined WARCs saved as: ${generatedCombinedWarcs}`);
  }

  async serializeConfig(done = false) {
    switch (this.params.saveState) {
    case "never":
      return;

    case "partial":
      if (!done) {
        return;
      }
      if (await this.crawlState.isFinished()) {
        return;
      }
      break;

    case "always":
    default:
      break;
    }

    const now = new Date();

    if (!done) {
      // if not done, save state only after specified interval has elapsed
      if (secondsElapsed(this.lastSaveTime, now) < this.params.saveStateInterval) {
        return;
      }
    }

    this.lastSaveTime = now.getTime();

    const ts = now.toISOString().slice(0,19).replace(/[T:-]/g, "");

    const crawlDir = path.join(this.collDir, "crawls");

    await fsp.mkdir(crawlDir, {recursive: true});

    const filenameOnly = `crawl-${ts}-${this.params.crawlId}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.crawlState.serialize();

    if (this.origConfig) {
      this.origConfig.state = state;
    }
    const res = yaml.dump(this.origConfig, {lineWidth: -1});
    try {
      logger.info(`Saving crawl state to: ${filename}`);
      await fsp.writeFile(filename, res);
    } catch (e) {
      logger.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    this.saveStateFiles.push(filename);

    if (this.saveStateFiles.length > this.params.saveStateHistory) {
      const oldFilename = this.saveStateFiles.shift();
      logger.info(`Removing old save-state: ${oldFilename}`);
      try {
        await fsp.unlink(oldFilename);
      } catch (e) {
        logger.error(`Failed to delete old save state file: ${oldFilename}`);
      }
    }

    if (this.storage && done && this.params.saveState === "always") {
      const targetFilename = interpolateFilename(filenameOnly, this.crawlId);

      await this.storage.uploadFile(filename, targetFilename);
    }
  }
}

function shouldIgnoreAbort(req) {
  try {
    const failure = req.failure() && req.failure().errorText;
    if (failure !== "net::ERR_ABORTED" || req.resourceType() !== "document") {
      return false;
    }

    const resp = req.response();
    const headers = resp && resp.headers();

    if (!headers) {
      return false;
    }

    if (headers["content-disposition"] || 
       (headers["content-type"] && !headers["content-type"].startsWith("text/"))) {
      return true;
    }
  } catch (e) {
    return false;
  }
}

