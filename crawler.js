import child_process from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import fsp from "fs/promises";
import http from "http";
import url from "url";

import fetch from "node-fetch";
import puppeteer from "puppeteer-core";
import { Cluster } from "puppeteer-cluster";
import { RedisCrawlState, MemoryCrawlState } from "./util/state.js";
import AbortController from "abort-controller";
import Sitemapper from "sitemapper";
import { v4 as uuidv4 } from "uuid";
import yaml from "js-yaml";

import * as warcio from "warcio";

import { TextExtract } from "./util/textextract.js";
import { initStorage, getFileSize, getDirSize, interpolateFilename } from "./util/storage.js";
import { ScreenCaster, WSTransport, RedisPubSubTransport } from "./util/screencaster.js";
import { parseArgs } from "./util/argParser.js";
import { initRedis } from "./util/redis.js";

import { getBrowserExe, loadProfile, chromeArgs, getDefaultUA, evaluateWithCLI } from "./util/browser.js";

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


// ============================================================================
export class Crawler {
  constructor() {
    this.headers = {};
    this.crawlState = null;

    this.emulateDevice = null;

    // pages file
    this.pagesFH = null;

    this.crawlId = process.env.CRAWL_ID || os.hostname();

    this.startTime = Date.now();

    // was the limit hit?
    this.limitHit = false;

    this.userAgent = "";

    const res = parseArgs();
    this.params = res.parsed;
    this.origConfig = res.origConfig;

    this.saveStateFiles = [];
    this.lastSaveTime = 0;
    this.saveStateInterval = this.params.saveStateInterval * 1000;

    this.debugLogging = this.params.logging.includes("debug");

    if (this.params.profile) {
      this.statusLog("With Browser Profile: " + this.params.profile);
    }

    this.emulateDevice = this.params.emulateDevice;

    this.debugLog("Seeds", this.params.scopedSeeds);

    this.captureBasePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/${this.params.collection}/record`;
    this.capturePrefix = process.env.NO_PROXY ? "" : this.captureBasePrefix + "/id_/";

    this.gotoOpts = {
      waitUntil: this.params.waitUntil,
      timeout: this.params.timeout
    };

    // root collections dir
    this.collDir = path.join(this.params.cwd, "collections", this.params.collection);

    // pages directory
    this.pagesDir = path.join(this.collDir, "pages");

    // pages file
    this.pagesFile = path.join(this.pagesDir, "pages.jsonl");

    this.blockRules = null;
    this.adBlockRules = null;

    this.errorCount = 0;

    this.interrupted = false;
    this.finalExit = false;
    this.clearOnExit = false;

    this.done = false;

    this.behaviorLastLine = null;

    this.logConsole = false;
  }

  statusLog(...args) {
    console.log(...args);
  }

  debugLog(...args) {
    if (this.debugLogging) {
      console.log(...args);
    }
  }

  configureUA() {
    // override userAgent
    if (this.params.userAgent) {

      if (this.emulateDevice) {
        this.emulateDevice.userAgent = this.params.userAgent;
      }

      this.userAgent = this.params.userAgent;
      return;
    }

    // if device set, it overrides the default Chrome UA
    if (this.emulateDevice) {
      this.userAgent = this.emulateDevice.userAgent;
    } else {
      this.userAgent = getDefaultUA();
    }

    // suffix to append to default userAgent
    if (this.params.userAgentSuffix) {
      this.userAgent += " " + this.params.userAgentSuffix;

      if (this.emulateDevice) {
        this.emulateDevice.userAgent += " " + this.params.userAgentSuffix;
      }
    }
  }

  async initCrawlState() {
    const redisUrl = this.params.redisStoreUrl;

    if (redisUrl) {
      if (!redisUrl.startsWith("redis://")) {
        throw new Error("stateStoreUrl must start with redis:// -- Only redis-based store currently supported");
      }

      let redis;

      while (true) {
        try {
          redis = await initRedis(redisUrl);
          break;
        } catch (e) {
          //throw new Error("Unable to connect to state store Redis: " + redisUrl);
          console.warn(`Waiting for redis at ${redisUrl}`);
          await this.sleep(3);
        }
      }

      this.statusLog(`Storing state via Redis ${redisUrl} @ key prefix "${this.crawlId}"`);

      this.crawlState = new RedisCrawlState(redis, this.params.crawlId, this.params.timeout * 2, os.hostname());

    } else {
      this.statusLog("Storing state in memory");

      this.crawlState = new MemoryCrawlState();
    }

    if (this.params.saveState === "always" && this.params.saveStateInterval) {
      this.statusLog(`Saving crawl state every ${this.params.saveStateInterval} seconds, keeping last ${this.params.saveStateHistory} states`);
    }

    return this.crawlState;
  }

  initScreenCaster() {
    let transport;

    if (this.params.screencastPort) {
      transport = new WSTransport(this.params.screencastPort);
      this.debugLog(`Screencast server started on: ${this.params.screencastPort}`);
    } else if (this.params.redisStoreUrl && this.params.screencastRedis) {
      transport = new RedisPubSubTransport(this.params.redisStoreUrl, this.crawlId);
      this.debugLog("Screencast enabled via redis pubsub");
    }

    if (!transport) {
      return null;
    }

    return new ScreenCaster(transport, this.params.workers);
  }

  async bootstrap() {
    const logs = path.join(this.collDir, "logs");

    const initRes = child_process.spawnSync("wb-manager", ["init", this.params.collection], {cwd: this.params.cwd});

    if (initRes.status) {
      console.log("wb-manager init failed, collection likely already exists");
    }

    await fsp.mkdir(logs, {recursive: true});

    let opts = {};
    let redisStdio;

    if (this.params.logging.includes("pywb")) {
      const pywbStderr = fs.openSync(path.join(logs, "pywb.log"), "a");
      const stdio = [process.stdin, pywbStderr, pywbStderr];

      const redisStderr = fs.openSync(path.join(logs, "redis.log"), "a");
      redisStdio = [process.stdin, redisStderr, redisStderr];

      opts = {stdio, cwd: this.params.cwd};
    } else {
      opts = {stdio: "ignore", cwd: this.params.cwd};
      redisStdio = "ignore";
    }

    this.logConsole = this.params.logging.includes("jserrors");

    this.browserExe = getBrowserExe();

    this.configureUA();

    this.headers = {"User-Agent": this.userAgent};

    const subprocesses = [];

    subprocesses.push(child_process.spawn("redis-server", {cwd: "/tmp/", stdio: redisStdio}));

    if (this.params.overwrite) {
      console.log(`Clearing ${this.collDir} before starting`);
      try {
        fs.rmSync(this.collDir, { recursive: true, force: true });
      } catch(e) {
        console.warn(e);
      }
    }

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

  get puppeteerArgs() {
    // Puppeter Options
    return {
      headless: this.params.headless,
      executablePath: this.browserExe,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ignoreHTTPSErrors: true,
      args: chromeArgs(!process.env.NO_PROXY, this.userAgent, this.extraChromeArgs()),
      userDataDir: this.profileDir,
      defaultViewport: null,
    };
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
      console.error("Crawl failed");
      console.error(e);
      exitCode = 9;
      status = "failing";
      if (await this.crawlState.incFailCount()) {
        status = "failed";
      }

    } finally {
      console.log(status);

      if (this.crawlState) {
        await this.crawlState.setStatus(status);
      }

      process.exit(exitCode);
    }
  }

  _behaviorLog({data, type}) {
    let behaviorLine;

    switch (type) {
    case "info":
      behaviorLine = JSON.stringify(data);
      if (behaviorLine != this._behaviorLastLine) {
        console.log(behaviorLine);
        this._behaviorLastLine = behaviorLine;
      }
      break;

    case "debug":
    default:
      if (this.params.behaviorsLogDebug) {
        console.log("behavior debug: " + JSON.stringify(data));
      }
    }
  }

  isInScope({seedId, url, depth, extraHops} = {}) {
    const seed = this.params.scopedSeeds[seedId];

    return seed.isIncluded(url, depth, extraHops);
  }

  async crawlPage(opts) {
    const {page, data} = opts;

    if (!this.isInScope(data)) {
      console.log(`No longer in scope: ${JSON.stringify(data)}`);
      return;
    }

    try {
      if (this.screencaster) {
        await this.screencaster.screencastTarget(page.target(), data.url);
      }

      if (this.emulateDevice) {
        await page.emulate(this.emulateDevice);
      }

      if (this.params.profile) {
        await page._client().send("Network.setBypassServiceWorker", {bypass: true});
      }

      await page.evaluateOnNewDocument("Object.defineProperty(navigator, \"webdriver\", {value: false});");

      if (this.params.behaviorOpts && !page.__bx_inited) {
        await page.exposeFunction(BEHAVIOR_LOG_FUNC, (logdata) => this._behaviorLog(logdata));
        await page.evaluateOnNewDocument(behaviors + `;\nself.__bx_behaviors.init(${this.params.behaviorOpts});`);
        page.__bx_inited = true;
      }

      // run custom driver here
      await this.driver({page, data, crawler: this});

      const title = await page.title();
      let text = "";
      if (this.params.text && page.isHTMLPage) {
        const client = await page.target().createCDPSession();
        const result = await client.send("DOM.getDocument", {"depth": -1, "pierce": true});
        text = await new TextExtract(result).parseTextFromDom();
      }

      await this.writePage(data, title, this.params.text ? text : null);

      if (this.params.behaviorOpts) {
        if (!page.isHTMLPage) {
          console.log("Skipping behaviors for non-HTML page");
        } else {
          await Promise.allSettled(page.frames().map(frame => evaluateWithCLI(frame, "self.__bx_behaviors.run();")));

          // also wait for general net idle
          await this.netIdle(page);
        }
      }

      await this.writeStats();

      await this.checkLimits();

      await this.serializeConfig();

    } catch (e) {
      console.warn(e);
      await this.markPageFailed(page);
    }
  }

  async createWARCInfo(filename) {
    const warcVersion = "WARC/1.0";
    const type = "warcinfo";
    const packageFileJSON = JSON.parse(await fsp.readFile("../app/package.json"));
    const warcioPackageJSON = JSON.parse(await fsp.readFile("/app/node_modules/warcio/package.json"));
    const pywbVersion = child_process.execSync("pywb -V", {encoding: "utf8"}).trim().split(" ")[1];

    const info = {
      "software": `Browsertrix-Crawler ${packageFileJSON.version} (with warcio.js ${warcioPackageJSON.version} pywb ${pywbVersion})`,
      "format": "WARC File Format 1.0"
    };
    
    const warcInfo = {...info, ...this.params.warcInfo, };
    const record = await warcio.WARCRecord.createWARCInfo({filename, type, warcVersion}, warcInfo);
    const buffer = await warcio.WARCSerializer.serialize(record, {gzip: true});
    return buffer;
  }

  async healthCheck(req, res) {
    const threshold = this.params.workers * 2;
    const pathname = url.parse(req.url).pathname;
    switch (pathname) {
    case "/healthz":
      if (this.errorCount < threshold) {
        console.log(`health check ok, num errors ${this.errorCount} < ${threshold}`);
        res.writeHead(200);
        res.end();
      }
      return;
    }

    console.log(`health check failed: ${this.errorCount} >= ${threshold}`);
    res.writeHead(503);
    res.end();
  }

  async checkLimits() {
    let interrupt = false;

    if (this.params.sizeLimit) {
      const dir = path.join(this.collDir, "archive");

      const size = await getDirSize(dir);

      if (size >= this.params.sizeLimit) {
        console.log(`Size threshold reached ${size} >= ${this.params.sizeLimit}, stopping`);
        interrupt = true;
        this.clearOnExit = true;
      }
    }

    if (this.params.timeLimit) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      if (elapsed > this.params.timeLimit) {
        console.log(`Time threshold reached ${elapsed} > ${this.params.timeLimit}, stopping`);
        interrupt = true;
      }
    }

    if (interrupt) {
      this.gracefulFinish();
    }
  }

  gracefulFinish() {
    this.crawlState.setDrain(true);
    this.interrupted = true;
    if (!this.params.waitOnDone) {
      this.finalExit = true;
    }
  }

  prepareForExit(markDone = true) {
    if (!markDone) {
      this.params.waitOnDone = false;
      this.clearOnExit = true;
      console.log("SIGNAL: Preparing for exit of this crawler instance only");
    } else {
      console.log("SIGNAL: Preparing for final exit of all crawlers");
      this.finalExit = true;
    }
  }

  async serializeAndExit() {
    await this.serializeConfig();
    process.exit(0);
  }

  async crawl() {
    this.profileDir = await loadProfile(this.params.profile);

    if (this.params.healthCheckPort) {
      this.healthServer = http.createServer((...args) => this.healthCheck(...args));
      this.statusLog(`Healthcheck server started on ${this.params.healthCheckPort}`);
      this.healthServer.listen(this.params.healthCheckPort);
    }

    try {
      const driverUrl = new URL(this.params.driver, import.meta.url);
      this.driver = (await import(driverUrl)).default;
    } catch(e) {
      console.warn(e);
      return;
    }

    await this.initCrawlState();

    let initState = await this.crawlState.getStatus();

    while (initState === "debug") {
      console.log("Paused for debugging, will continue after manual resume");

      await this.sleep(60);

      initState = await this.crawlState.getStatus();
    }

    // if already done, don't crawl anymore
    if (initState === "done") {
      this.done = true;

      if (this.params.waitOnDone) {
        this.statusLog("Already done, waiting for signal to exit...");

        // wait forever until signal
        await new Promise(() => {});
      }

      return;
    }

    if (this.params.generateWACZ) {
      this.storage = initStorage();
    }

    // Puppeteer Cluster init and options
    this.cluster = await Cluster.launch({
      concurrency: this.params.newContext,
      maxConcurrency: this.params.workers,
      skipDuplicateUrls: false,
      timeout: this.params.timeout * 2,
      puppeteerOptions: this.puppeteerArgs,
      puppeteer,
      monitor: this.params.logging.includes("stats")
    });


    this.cluster.jobQueue = this.crawlState;

    await this.crawlState.setStatus("running");

    if (this.params.state) {
      await this.crawlState.load(this.params.state, this.params.scopedSeeds, true);
    }

    this.cluster.task((opts) => this.crawlPage(opts));

    await this.initPages();

    if (this.params.blockAds) {
      this.adBlockRules = new AdBlockRules(this.captureBasePrefix, this.params.adBlockMessage, (text) => this.debugLog(text));
    }

    if (this.params.blockRules && this.params.blockRules.length) {
      this.blockRules = new BlockRules(this.params.blockRules, this.captureBasePrefix, this.params.blockMessage, (text) => this.debugLog(text));
    }

    this.screencaster = this.initScreenCaster();

    if (this.cluster.browser.setScreencaster) {
      this.cluster.browser.setScreencaster(this.screencaster);
    }

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

    await this.cluster.idle();
    await this.cluster.close();

    await this.serializeConfig(true);

    this.writeStats();

    if (this.pagesFH) {
      await this.pagesFH.sync();
      await this.pagesFH.close();
    }

    // extra wait for all resources to land into WARCs
    await this.awaitPendingClear();

    if (this.params.combineWARC) {
      await this.combineWARC();
    }

    if (this.params.generateCDX) {
      this.statusLog("Generating CDX");

      await this.awaitProcess(child_process.spawn("wb-manager", ["reindex", this.params.collection], {stdio: "inherit", cwd: this.params.cwd}));
    }

    if (this.params.generateWACZ && (!this.interrupted || this.finalExit || this.clearOnExit)) {
      await this.generateWACZ();

      if (this.clearOnExit) {
        console.log(`Clearing ${this.collDir} before exit`);
        try {
          fs.rmSync(this.collDir, { recursive: true, force: true });
        } catch(e) {
          console.warn(e);
        }
      }
    }

    if (this.params.waitOnDone && (!this.interrupted || this.finalExit)) {
      this.done = true;
      this.statusLog("All done, waiting for signal...");
      await this.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  async generateWACZ() {
    this.statusLog("Generating WACZ");

    const archiveDir = path.join(this.collDir, "archive");

    // Get a list of the warcs inside
    const warcFileList = await fsp.readdir(archiveDir);

    // is finished (>0 pages and all pages written)
    const isFinished = await this.crawlState.isFinished();

    console.log(`Num WARC Files: ${warcFileList.length}`);
    if (!warcFileList.length) {
      // if finished, just return
      if (isFinished) {
        return;
      }
      throw new Error("No WARC Files, assuming crawl failed");
    }

    // Build the argument list to pass to the wacz create command
    const waczFilename = this.params.collection.concat(".wacz");
    const waczPath = path.join(this.collDir, waczFilename);

    const createArgs = ["create", "--split-seeds", "-o", waczPath, "--pages", this.pagesFile];

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
    const waczResult = await this.awaitProcess(child_process.spawn("wacz" , createArgs, {stdio: "inherit"}));

    if (waczResult !== 0) {
      console.log("create result", waczResult);
      throw new Error("Unable to write WACZ successfully");
    }

    this.debugLog(`WACZ successfully generated and saved to: ${waczPath}`);

    // Verify WACZ
    /*
    const validateArgs = ["validate"];
    validateArgs.push("-f");
    validateArgs.push(waczPath);

    const waczVerifyResult = await this.awaitProcess(child_process.spawn("wacz", validateArgs, {stdio: "inherit"}));

    if (waczVerifyResult !== 0) {
      console.log("validate", waczVerifyResult);
      throw new Error("Unable to verify WACZ created successfully");
    }
*/
    if (this.storage) {
      const filename = process.env.STORE_FILENAME || "@ts-@id.wacz";
      const targetFilename = interpolateFilename(filename, this.crawlId);

      await this.storage.uploadCollWACZ(waczPath, targetFilename, isFinished);
    }
  }

  awaitProcess(proc) {
    return new Promise((resolve) => {
      proc.on("close", (code) => resolve(code));
    });
  }

  async writeStats() {
    if (this.params.statsFilename) {
      const total = this.cluster.allTargetCount;
      const workersRunning = this.cluster.workersBusy.length;
      const numCrawled = total - (await this.crawlState.size()) - workersRunning;
      const limit = {max: this.params.limit || 0, hit: this.limitHit};
      const stats = {numCrawled, workersRunning, total, limit};

      try {
        await fsp.writeFile(this.params.statsFilename, JSON.stringify(stats, null, 2));
      } catch (err) {
        console.warn("Stats output failed", err);
      }
    }
  }

  async loadPage(page, urlData, selectorOptsList = DEFAULT_SELECTORS) {
    const {url, seedId, depth, extraHops = 0} = urlData;

    let isHTMLPage = true;

    if (!await this.isHTML(url)) {
      isHTMLPage = false;
      try {
        if (await this.directFetchCapture(url)) {
          return;
        }
      } catch (e) {
        // ignore failed direct fetch attempt, do browser-based capture
      }
    }

    if (this.adBlockRules) {
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

    // more serious page error, mark page session as invalid
    page.on("error", () => this.markPageFailed(page));

    if (this.logConsole) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          console.log(msg.text(), msg.location());
        }
      });
    }

    const gotoOpts = isHTMLPage ? this.gotoOpts : "domcontentloaded";

    try {
      await page.goto(url, gotoOpts);
      if (this.errorCount > 0) {
        this.statusLog(`Page loaded, resetting error count ${this.errorCount} to 0`);
        this.errorCount = 0;
      }
    } catch (e) {
      let msg = e.message || "";
      if (!msg.startsWith("net::ERR_ABORTED") || !ignoreAbort) {
        this.statusLog(`Load Error: ${url}: ${msg}`);
        this.errorCount++;
      }
    }

    page.isHTMLPage = isHTMLPage;

    if (!isHTMLPage) {
      return;
    }

    const seed = this.params.scopedSeeds[seedId];

    await this.checkCF(page);

    await this.netIdle(page);

    await this.sleep(5);

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(depth) || !selectorOptsList) {
      return;
    }

    for (const opts of selectorOptsList) {
      const links = await this.extractLinks(page, opts);
      await this.queueInScopeUrls(seedId, links, depth, extraHops);
    }
  }

  async markPageFailed(page) {
    page.__failed = true;
    this.errorCount++;
    if (this.screencaster) {
      await this.screencaster.endTarget(page.target());
    }
  }

  async netIdle(page) {
    if (!this.params.netIdleWait) {
      return;
    }
    // in case page starts loading via fetch/xhr immediately after page load,
    // we want to ensure we don't exit too early
    await this.sleep(0.5);

    try {
      await page.waitForNetworkIdle({timeout: this.params.netIdleWait * 1000});
    } catch (e) {
      console.log("note: waitForNetworkIdle timed out, ignoring");
      // ignore, continue
    }
  }

  async extractLinks(page, {selector = "a[href]", extract = "href", isAttribute = false} = {}) {
    const results = [];

    const loadProp = (selector, extract) => {
      return [...document.querySelectorAll(selector)].map(elem => elem[extract]);
    };

    const loadAttr = (selector, extract) => {
      return [...document.querySelectorAll(selector)].map(elem => elem.getAttribute(extract));
    };

    const loadFunc = isAttribute ? loadAttr : loadProp;

    try {
      const linkResults = await Promise.allSettled(page.frames().map(frame => frame.evaluate(loadFunc, selector, extract)));

      if (linkResults) {
        for (const linkResult of linkResults) {
          if (!linkResult.value) continue;
          for (const link of linkResult.value) {
            results.push(link);
          }
        }
      }

    } catch (e) {
      console.warn("Link Extraction failed", e);
    }
    return results;
  }

  async queueInScopeUrls(seedId, urls, depth, extraHops = 0) {
    try {
      depth += 1;

      // new number of extra hops, set if this hop is out-of-scope (oos)
      const newExtraHops = extraHops + 1;

      for (const possibleUrl of urls) {
        const res = this.isInScope({url: possibleUrl, extraHops: newExtraHops, depth, seedId});

        if (!res) {
          continue;
        }

        const {url, isOOS} = res;

        if (url) {
          await this.queueUrl(seedId, url, depth, isOOS ? newExtraHops : extraHops);
        }
      }
    } catch (e) {
      console.error("Queuing Error: ", e);
    }
  }

  async checkCF(page) {
    try {
      while (await page.$("div.cf-browser-verification.cf-im-under-attack")) {
        this.statusLog("Cloudflare Check Detected, waiting for reload...");
        await this.sleep(5.5);
      }
    } catch (e) {
      //console.warn("Check CF failed, ignoring");
      //console.warn(e);
    }
  }

  async queueUrl(seedId, url, depth, extraHops = 0) {
    if (this.limitHit) {
      return false;
    }

    if (this.params.limit > 0 && (await this.crawlState.numRealSeen() >= this.params.limit)) {
      this.limitHit = true;
      return false;
    }

    if (await this.crawlState.has(url)) {
      return false;
    }

    await this.crawlState.add(url);
    const urlData = {url, seedId, depth};
    if (extraHops) {
      urlData.extraHops = extraHops;
    }
    this.cluster.queue(urlData);
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
          this.statusLog("Text Extraction: Enabled");
        } else {
          header["hasText"] = false;
          this.statusLog("Text Extraction: Disabled");
        }
        const header_formatted = JSON.stringify(header).concat("\n");
        await this.pagesFH.writeFile(header_formatted);
      }

    } catch(err) {
      console.error("pages/pages.jsonl creation failed", err);
    }
  }

  async writePage({url, depth}, title, text) {
    const id = uuidv4();
    const row = {"id": id, "url": url, "title": title};

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
      console.warn("pages/pages.jsonl append failed", err);
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
        this.debugLog(`Skipping HEAD check ${url}, invalid status ${resp.status}`);
        return true;
      }

      const contentType = resp.headers.get("Content-Type");

      // just load if no content-type
      if (!contentType) {
        return true;
      }

      const mime = contentType.split(";")[0];

      if (HTML_TYPES.includes(mime)) {
        return true;
      }

      return false;
    } catch(e) {
      // can't confirm not html, so try in browser
      return true;
    }
  }

  async directFetchCapture(url) {
    //console.log(`Direct capture: ${this.capturePrefix}${url}`);
    const abort = new AbortController();
    const signal = abort.signal;
    const resp = await fetch(this.capturePrefix + url, {signal, headers: this.headers, redirect: "manual"});
    abort.abort();
    return resp.status === 200 && !resp.headers.get("set-cookie");
  }

  async awaitPendingClear() {
    this.statusLog("Waiting to ensure pending data is written to WARCs...");

    const redis = await initRedis("redis://localhost/0");

    // wait for pending requests upto 120 secs, unless canceling
    const MAX_WAIT = 120;

    for (let i = 0; i < MAX_WAIT && !this.interrupted; i++) {
      try {
        const count = Number(await redis.get(`pywb:${this.params.collection}:pending`) || 0);
        if (count <= 0) {
          break;
        }
        this.debugLog(`Still waiting for ${count} pending requests to finish...`);
      } catch (e) {
        break;
      }

      await this.sleep(1);
    }
  }

  sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
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
      console.warn(e);
    }
  }

  async combineWARC() {
    this.statusLog("Generating Combined WARCs");

    // Get the list of created Warcs
    const warcLists = await fsp.readdir(path.join(this.collDir, "archive"));

    this.debugLog(`Combining ${warcLists.length} WARCs...`);

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

      this.debugLog(`Appending WARC ${fileSizeObjects[j].fileName}`);

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

    this.debugLog(`Combined WARCs saved as: ${generatedCombinedWarcs}`);
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
      if ((now.getTime() - this.lastSaveTime) < this.saveStateInterval) {
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
      this.statusLog("Saving crawl state to: " + filename);
      await fsp.writeFile(filename, res);
    } catch (e) {
      console.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    this.saveStateFiles.push(filename);

    if (this.saveStateFiles.length > this.params.saveStateHistory) {
      const oldFilename = this.saveStateFiles.shift();
      this.statusLog(`Removing old save-state: ${oldFilename}`);
      try {
        await fsp.unlink(oldFilename);
      } catch (e) {
        console.error(`Failed to delete old save state file: ${oldFilename}`);
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

