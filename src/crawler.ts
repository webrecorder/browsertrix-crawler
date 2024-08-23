import child_process, { ChildProcess, StdioOptions } from "child_process";
import path from "path";
import fs, { WriteStream } from "fs";
import os from "os";
import fsp from "fs/promises";

import {
  RedisCrawlState,
  LoadState,
  QueueState,
  PageState,
  WorkerId,
} from "./util/state.js";

import { parseArgs } from "./util/argParser.js";

import yaml from "js-yaml";

import { WACZ, WACZInitOpts, mergeCDXJ } from "./util/wacz.js";

import { HealthChecker } from "./util/healthcheck.js";
import { TextExtractViaSnapshot } from "./util/textextract.js";
import {
  initStorage,
  getFileSize,
  getDirSize,
  interpolateFilename,
  checkDiskUtilization,
  S3StorageSync,
} from "./util/storage.js";
import { ScreenCaster, WSTransport } from "./util/screencaster.js";
import { Screenshots } from "./util/screenshots.js";
import { initRedis } from "./util/redis.js";
import { logger, formatErr, LogDetails } from "./util/logger.js";
import {
  WorkerOpts,
  WorkerState,
  closeWorkers,
  runWorkers,
} from "./util/worker.js";
import { sleep, timedRun, secondsElapsed } from "./util/timing.js";
import { collectAllFileSources, getInfoString } from "./util/file_reader.js";

import { Browser } from "./util/browser.js";

import {
  ADD_LINK_FUNC,
  BEHAVIOR_LOG_FUNC,
  DEFAULT_SELECTORS,
  DISPLAY,
} from "./util/constants.js";

import { AdBlockRules, BlockRules } from "./util/blockrules.js";
import { OriginOverride } from "./util/originoverride.js";

import {
  CDPSession,
  Frame,
  HTTPRequest,
  HTTPResponse,
  Page,
  Protocol,
} from "puppeteer-core";
import { Recorder } from "./util/recorder.js";
import { SitemapReader } from "./util/sitemapper.js";
import { ScopedSeed } from "./util/seeds.js";
import {
  WARCWriter,
  createWARCInfo,
  setWARCInfo,
  streamFinish,
} from "./util/warcwriter.js";
import { isHTMLMime, isRedirectStatus } from "./util/reqresp.js";
import { initProxy } from "./util/proxy.js";

const behaviors = fs.readFileSync(
  new URL(
    "../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url,
  ),
  { encoding: "utf8" },
);

const FETCH_TIMEOUT_SECS = 30;
const PAGE_OP_TIMEOUT_SECS = 5;
const SITEMAP_INITIAL_FETCH_TIMEOUT_SECS = 30;

const RUN_DETACHED = process.env.DETACHED_CHILD_PROC == "1";

const POST_CRAWL_STATES = [
  "generate-wacz",
  "uploading-wacz",
  "generate-cdx",
  "generate-warc",
];

type PageEntry = {
  id: string;
  url: string;
  title?: string;
  loadState?: number;
  mime?: string;
  seed?: boolean;
  text?: string;
  favIconUrl?: string;
  ts?: string;
  status?: number;
};

// ============================================================================
export class Crawler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  origConfig: any;

  collDir: string;
  logDir: string;
  logFilename: string;

  headers: Record<string, string> = {};

  crawlState!: RedisCrawlState;

  pagesFH?: WriteStream | null = null;
  extraPagesFH?: WriteStream | null = null;
  logFH: WriteStream | null = null;

  crawlId: string;

  startTime: number;

  limitHit = false;
  pageLimit: number;

  saveStateFiles: string[] = [];
  lastSaveTime: number;

  maxPageTime: number;

  seeds: ScopedSeed[];
  numOriginalSeeds = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emulateDevice: any = {};

  captureBasePrefix = "";

  infoString!: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gotoOpts: Record<string, any>;

  pagesDir: string;
  seedPagesFile: string;
  otherPagesFile: string;

  archivesDir: string;
  tempdir: string;
  tempCdxDir: string;
  indexesDir: string;

  screenshotWriter: WARCWriter | null;
  textWriter: WARCWriter | null;

  blockRules: BlockRules | null;
  adBlockRules: AdBlockRules | null;

  healthChecker: HealthChecker | null = null;
  originOverride: OriginOverride | null = null;

  screencaster: ScreenCaster | null = null;

  skipTextDocs = 0;

  interrupted = false;
  finalExit = false;
  uploadAndDeleteLocal = false;
  done = false;

  textInPages = false;

  customBehaviors = "";
  behaviorsChecked = false;
  behaviorLastLine?: string;

  browser: Browser;
  storage: S3StorageSync | null = null;

  maxHeapUsed = 0;
  maxHeapTotal = 0;

  proxyServer?: string;

  driver!: (opts: {
    page: Page;
    data: PageState;
    // eslint-disable-next-line no-use-before-define
    crawler: Crawler;
  }) => NonNullable<unknown>;

  recording: boolean;

  constructor() {
    const args = this.parseArgs();
    this.params = args.parsed;
    this.origConfig = args.origConfig;

    // root collections dir
    this.collDir = path.join(
      this.params.cwd,
      "collections",
      this.params.collection,
    );
    this.logDir = path.join(this.collDir, "logs");
    this.logFilename = path.join(
      this.logDir,
      `crawl-${new Date().toISOString().replace(/[^\d]/g, "")}.log`,
    );

    const debugLogging = this.params.logging.includes("debug");
    logger.setDebugLogging(debugLogging);
    logger.setLogLevel(this.params.logLevel);
    logger.setContext(this.params.logContext);
    logger.setExcludeContext(this.params.logExcludeContext);

    // if automatically restarts on error exit code,
    // exit with 0 from fatal by default, to avoid unnecessary restart
    // otherwise, exit with default fatal exit code
    if (this.params.restartsOnError) {
      logger.setDefaultFatalExitCode(0);
    }

    logger.debug("Writing log to: " + this.logFilename, {}, "general");

    this.recording = !this.params.dryRun;
    if (this.params.dryRun) {
      logger.warn(
        "Dry run mode: no archived data stored, only pages and logging. Storage and archive creation related options will be ignored.",
      );
    }

    this.headers = {};

    // pages file
    this.pagesFH = null;

    this.crawlId = process.env.CRAWL_ID || os.hostname();

    this.startTime = Date.now();

    // was the limit hit?
    this.limitHit = false;
    this.pageLimit = this.params.pageLimit;

    // resolve maxPageLimit and ensure pageLimit is no greater than maxPageLimit
    if (this.params.maxPageLimit) {
      this.pageLimit = this.pageLimit
        ? Math.min(this.pageLimit, this.params.maxPageLimit)
        : this.params.maxPageLimit;
    }

    this.saveStateFiles = [];
    this.lastSaveTime = 0;

    this.seeds = this.params.scopedSeeds as ScopedSeed[];
    this.numOriginalSeeds = this.seeds.length;

    // sum of page load + behavior timeouts + 2 x fetch + cloudflare + link extraction timeouts + extra page delay
    // if exceeded, will interrupt and move on to next page (likely behaviors or some other operation is stuck)
    this.maxPageTime =
      this.params.pageLoadTimeout +
      this.params.behaviorTimeout +
      FETCH_TIMEOUT_SECS * 2 +
      PAGE_OP_TIMEOUT_SECS * 2 +
      this.params.pageExtraDelay;

    this.emulateDevice = this.params.emulateDevice || {};

    //this.captureBasePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/${this.params.collection}/record`;
    //this.capturePrefix = "";//process.env.NO_PROXY ? "" : this.captureBasePrefix + "/id_/";
    //this.captureBasePrefix = "";

    this.gotoOpts = {
      waitUntil: this.params.waitUntil,
      timeout: this.params.pageLoadTimeout * 1000,
    };

    // pages directory
    this.pagesDir = path.join(this.collDir, "pages");

    // pages file
    this.seedPagesFile = path.join(this.pagesDir, "pages.jsonl");
    this.otherPagesFile = path.join(this.pagesDir, "extraPages.jsonl");

    // archives dir
    this.archivesDir = path.join(this.collDir, "archive");
    this.tempdir = path.join(os.tmpdir(), "tmp-dl");

    // indexes dirs
    this.tempCdxDir = path.join(this.collDir, "tmp-cdx");
    this.indexesDir = path.join(this.collDir, "indexes");

    this.screenshotWriter = null;
    this.textWriter = null;

    this.blockRules = null;
    this.adBlockRules = null;

    this.healthChecker = null;

    this.interrupted = false;
    this.finalExit = false;
    this.uploadAndDeleteLocal = false;

    this.textInPages = this.params.text.includes("to-pages");

    this.done = false;

    this.customBehaviors = "";

    this.browser = new Browser();
  }

  protected parseArgs() {
    return parseArgs();
  }

  configureUA() {
    // override userAgent
    if (this.params.userAgent) {
      this.emulateDevice.userAgent = this.params.userAgent;
      return this.params.userAgent;
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
      logger.fatal(
        "stateStoreUrl must start with redis:// -- Only redis-based store currently supported",
      );
    }

    let redis;

    while (true) {
      try {
        redis = await initRedis(redisUrl);
        break;
      } catch (e) {
        //logger.fatal("Unable to connect to state store Redis: " + redisUrl);
        logger.warn(`Waiting for redis at ${redisUrl}`, {}, "state");
        await sleep(1);
      }
    }

    logger.debug(
      `Storing state via Redis ${redisUrl} @ key prefix "${this.crawlId}"`,
      {},
      "state",
    );

    logger.debug(`Max Page Time: ${this.maxPageTime} seconds`, {}, "state");

    this.crawlState = new RedisCrawlState(
      redis,
      this.params.crawlId,
      this.maxPageTime,
      os.hostname(),
    );

    // load full state from config
    if (this.params.state) {
      await this.crawlState.load(this.params.state, this.seeds, true);
      // otherwise, just load extra seeds
    } else {
      await this.loadExtraSeeds();
    }

    // clear any pending URLs from this instance
    await this.crawlState.clearOwnPendingLocks();

    if (this.params.saveState === "always" && this.params.saveStateInterval) {
      logger.debug(
        `Saving crawl state every ${this.params.saveStateInterval} seconds, keeping last ${this.params.saveStateHistory} states`,
        {},
        "state",
      );
    }

    if (this.params.logErrorsToRedis) {
      logger.setLogErrorsToRedis(true);
      logger.setCrawlState(this.crawlState);
    }

    return this.crawlState;
  }

  async loadExtraSeeds() {
    const extraSeeds = await this.crawlState.getExtraSeeds();

    for (const { origSeedId, newUrl } of extraSeeds) {
      const seed = this.seeds[origSeedId];
      this.seeds.push(seed.newScopedSeed(newUrl));
    }
  }

  initScreenCaster() {
    let transport;

    if (this.params.screencastPort) {
      transport = new WSTransport(this.params.screencastPort);
      logger.debug(
        `Screencast server started on: ${this.params.screencastPort}`,
        {},
        "screencast",
      );
    }
    // } else if (this.params.redisStoreUrl && this.params.screencastRedis) {
    //   transport = new RedisPubSubTransport(this.params.redisStoreUrl, this.crawlId);
    //   logger.debug("Screencast enabled via redis pubsub", {}, "screencast");
    // }

    if (!transport) {
      return null;
    }

    return new ScreenCaster(transport, this.params.workers);
  }

  launchRedis() {
    let redisStdio: StdioOptions;

    if (this.params.logging.includes("redis")) {
      const redisStderr = fs.openSync(path.join(this.logDir, "redis.log"), "a");
      redisStdio = [process.stdin, redisStderr, redisStderr];
    } else {
      redisStdio = "ignore";
    }

    let redisArgs: string[] = [];
    if (this.params.debugAccessRedis) {
      redisArgs = ["--protected-mode", "no"];
    }

    return child_process.spawn("redis-server", redisArgs, {
      cwd: "/tmp/",
      stdio: redisStdio,
      detached: RUN_DETACHED,
    });
  }

  async bootstrap() {
    const subprocesses: ChildProcess[] = [];

    this.proxyServer = initProxy(this.params.proxyServer);

    const redisUrl = this.params.redisStoreUrl || "redis://localhost:6379/0";

    if (
      redisUrl.startsWith("redis://localhost:") ||
      redisUrl.startsWith("redis://127.0.0.1:")
    ) {
      subprocesses.push(this.launchRedis());
    }

    await fsp.mkdir(this.logDir, { recursive: true });

    if (!this.params.dryRun) {
      await fsp.mkdir(this.archivesDir, { recursive: true });
      await fsp.mkdir(this.tempdir, { recursive: true });
      await fsp.mkdir(this.tempCdxDir, { recursive: true });
    }

    this.logFH = fs.createWriteStream(this.logFilename, { flags: "a" });
    logger.setExternalLogStream(this.logFH);

    this.infoString = await getInfoString();
    setWARCInfo(this.infoString, this.params.warcInfo);
    logger.info(this.infoString);

    logger.info("Seeds", this.seeds);

    logger.info("Behavior Options", this.params.behaviorOpts);

    if (this.params.profile) {
      logger.info("With Browser Profile", { url: this.params.profile });
    }

    if (this.params.overwrite) {
      logger.debug(`Clearing ${this.collDir} before starting`);
      try {
        fs.rmSync(this.collDir, { recursive: true, force: true });
      } catch (e) {
        logger.error(`Unable to clear ${this.collDir}`, e);
      }
    }

    if (this.params.customBehaviors) {
      this.customBehaviors = this.loadCustomBehaviors(
        this.params.customBehaviors,
      );
    }

    this.headers = { "User-Agent": this.configureUA() };

    process.on("exit", () => {
      for (const proc of subprocesses) {
        proc.kill();
      }
    });

    if (this.params.debugAccessBrowser) {
      child_process.spawn(
        "socat",
        ["tcp-listen:9222,reuseaddr,fork", "tcp:localhost:9221"],
        { detached: RUN_DETACHED },
      );
    }

    if (!this.params.headless && !process.env.NO_XVFB) {
      child_process.spawn(
        "Xvfb",
        [
          DISPLAY,
          "-listen",
          "tcp",
          "-screen",
          "0",
          process.env.GEOMETRY || "",
          "-ac",
          "+extension",
          "RANDR",
        ],
        { detached: RUN_DETACHED },
      );
    }

    if (this.params.screenshot && !this.params.dryRun) {
      this.screenshotWriter = this.createExtraResourceWarcWriter("screenshots");
    }
    if (this.params.text && !this.params.dryRun) {
      this.textWriter = this.createExtraResourceWarcWriter("text");
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

    let status = "done";
    let exitCode = 0;

    try {
      await this.crawl();
      const finished = await this.crawlState.isFinished();
      const stopped = await this.crawlState.isCrawlStopped();
      const canceled = await this.crawlState.isCrawlCanceled();
      if (!finished) {
        if (canceled) {
          status = "canceled";
        } else if (stopped) {
          status = "done";
          logger.info("Crawl gracefully stopped on request");
        } else if (this.interrupted) {
          status = "interrupted";
          exitCode = 11;
        }
      }
    } catch (e) {
      logger.error("Crawl failed", e);
      exitCode = 9;
      status = "failing";
      if (await this.crawlState.incFailCount()) {
        status = "failed";
      }
    } finally {
      await this.setStatusAndExit(exitCode, status);
    }
  }

  _behaviorLog(
    { data, type }: { data: string; type: string },
    pageUrl: string,
    workerid: WorkerId,
  ) {
    let behaviorLine;
    let message;
    let details;

    const logDetails = { page: pageUrl, workerid };

    if (typeof data === "string") {
      message = data;
      details = logDetails;
    } else {
      message = type === "info" ? "Behavior log" : "Behavior debug";
      details =
        typeof data === "object"
          ? { ...(data as object), ...logDetails }
          : logDetails;
    }

    switch (type) {
      case "info":
        behaviorLine = JSON.stringify(data);
        if (behaviorLine !== this.behaviorLastLine) {
          logger.info(message, details, "behaviorScript");
          this.behaviorLastLine = behaviorLine;
        }
        break;

      case "error":
        logger.error(message, details, "behaviorScript");
        break;

      case "debug":
      default:
        logger.debug(message, details, "behaviorScript");
    }
  }

  protected getScope(
    {
      seedId,
      url,
      depth,
      extraHops,
      noOOS,
    }: {
      seedId: number;
      url: string;
      depth: number;
      extraHops: number;
      noOOS: boolean;
    },
    logDetails = {},
  ) {
    return this.seeds[seedId].isIncluded(
      url,
      depth,
      extraHops,
      logDetails,
      noOOS,
    );
  }

  async isInScope(
    {
      seedId,
      url,
      depth,
      extraHops,
    }: { seedId: number; url: string; depth: number; extraHops: number },
    logDetails = {},
  ): Promise<boolean> {
    const seed = await this.crawlState.getSeedAt(
      this.seeds,
      this.numOriginalSeeds,
      seedId,
    );

    return !!seed.isIncluded(url, depth, extraHops, logDetails);
  }

  async setupPage({
    page,
    cdp,
    workerid,
    callbacks,
    frameIdToExecId,
  }: WorkerOpts) {
    await this.browser.setupPage({ page, cdp });

    await this.setupExecContextEvents(cdp, frameIdToExecId);

    if (
      (this.adBlockRules && this.params.blockAds) ||
      this.blockRules ||
      this.originOverride
    ) {
      await page.setRequestInterception(true);

      if (this.adBlockRules && this.params.blockAds) {
        await this.adBlockRules.initPage(this.browser, page);
      }

      if (this.blockRules) {
        await this.blockRules.initPage(this.browser, page);
      }

      if (this.originOverride) {
        await this.originOverride.initPage(this.browser, page);
      }
    }

    if (this.params.logging.includes("jserrors")) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          logger.warn(
            msg.text(),
            { location: msg.location(), page: page.url(), workerid },
            "jsError",
          );
        }
      });

      page.on("pageerror", (e) => {
        logger.warn(
          "Page Error",
          { ...formatErr(e), page: page.url(), workerid },
          "jsError",
        );
      });
    }

    if (this.screencaster) {
      logger.debug("Start Screencast", { workerid }, "screencast");
      await this.screencaster.screencastPage(page, cdp, workerid);
    }

    await page.exposeFunction(
      ADD_LINK_FUNC,
      (url: string) => callbacks.addLink && callbacks.addLink(url),
    );

    if (this.params.behaviorOpts) {
      await page.exposeFunction(
        BEHAVIOR_LOG_FUNC,
        (logdata: { data: string; type: string }) =>
          this._behaviorLog(logdata, page.url(), workerid),
      );
      await this.browser.addInitScript(page, behaviors);

      const initScript = `
self.__bx_behaviors.init(${this.params.behaviorOpts}, false);
${this.customBehaviors}
self.__bx_behaviors.selectMainBehavior();
`;
      if (!this.behaviorsChecked && this.customBehaviors) {
        await this.checkBehaviorScripts(cdp);
        this.behaviorsChecked = true;
      }

      await this.browser.addInitScript(page, initScript);
    }
  }

  async setupExecContextEvents(
    cdp: CDPSession,
    frameIdToExecId: Map<string, number>,
  ) {
    await cdp.send("Runtime.enable");

    await cdp.on(
      "Runtime.executionContextCreated",
      (params: Protocol.Runtime.ExecutionContextCreatedEvent) => {
        const { id, auxData } = params.context;
        if (auxData && auxData.isDefault && auxData.frameId) {
          frameIdToExecId.set(auxData.frameId, id);
        }
      },
    );

    await cdp.on(
      "Runtime.executionContextDestroyed",
      (params: Protocol.Runtime.ExecutionContextDestroyedEvent) => {
        const { executionContextId } = params;
        for (const [frameId, execId] of frameIdToExecId.entries()) {
          if (execId === executionContextId) {
            frameIdToExecId.delete(frameId);
            break;
          }
        }
      },
    );

    await cdp.on("Runtime.executionContextsCleared", () => {
      frameIdToExecId.clear();
    });
  }

  loadCustomBehaviors(filename: string) {
    let str = "";

    for (const { contents } of collectAllFileSources(filename, ".js")) {
      str += `self.__bx_behaviors.load(${contents});\n`;
    }

    return str;
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const filename = this.params.customBehaviors;

    if (!filename) {
      return;
    }

    for (const { path, contents } of collectAllFileSources(filename, ".js")) {
      await this.browser.checkScript(cdp, path, contents);
    }
  }

  async getFavicon(page: Page, logDetails: LogDetails): Promise<string> {
    try {
      const resp = await fetch("http://127.0.0.1:9221/json");
      if (resp.status === 200) {
        const browserJson = await resp.json();
        for (const jsons of browserJson) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (jsons.id === (page.target() as any)._targetId) {
            return jsons.faviconUrl;
          }
        }
      }
    } catch (e) {
      // ignore
    }
    logger.warn(
      "Failed to fetch favicon from browser /json endpoint",
      logDetails,
    );
    return "";
  }

  async crawlPage(opts: WorkerState): Promise<void> {
    await this.writeStats();

    const { page, cdp, data, workerid, callbacks, directFetchCapture } = opts;
    data.callbacks = callbacks;

    const { url, seedId } = data;

    const auth = this.seeds[seedId].authHeader();

    if (auth) {
      logger.debug("Setting HTTP basic auth for seed", {
        seedId,
        seedUrl: this.seeds[seedId].url,
      });
      await page.setExtraHTTPHeaders({ Authorization: auth });
      opts.isAuthSet = true;
    } else if (opts.isAuthSet) {
      await page.setExtraHTTPHeaders({});
    }

    const logDetails = { page: url, workerid };
    data.logDetails = logDetails;
    data.workerid = workerid;

    if (directFetchCapture) {
      try {
        const { fetched, mime, ts } = await timedRun(
          directFetchCapture({ url, headers: this.headers, cdp }),
          FETCH_TIMEOUT_SECS,
          "Direct fetch capture attempt timed out",
          logDetails,
          "fetch",
          true,
        );
        if (mime) {
          data.mime = mime;
          data.isHTMLPage = isHTMLMime(mime);
        }
        if (fetched) {
          data.loadState = LoadState.FULL_PAGE_LOADED;
          data.status = 200;
          data.ts = ts || new Date();
          logger.info(
            "Direct fetch successful",
            { url, mime, ...logDetails },
            "fetch",
          );
          return;
        }
      } catch (e) {
        // filtered out direct fetch
        logger.debug(
          "Direct fetch response not accepted, continuing with browser fetch",
          logDetails,
          "fetch",
        );
      }
    }

    // run custom driver here
    await this.driver({ page, data, crawler: this });

    data.title = await page.title();
    data.favicon = await this.getFavicon(page, logDetails);

    await this.doPostLoadActions(opts);

    await this.awaitPageExtraDelay(opts);
  }

  async doPostLoadActions(opts: WorkerState, saveOutput = false) {
    const { page, cdp, data, workerid } = opts;
    const { url } = data;

    if (!data.isHTMLPage) {
      return;
    }

    const logDetails = { page: url, workerid };

    if (this.params.screenshot && this.screenshotWriter) {
      const screenshots = new Screenshots({
        browser: this.browser,
        page,
        url,
        writer: this.screenshotWriter,
      });
      if (this.params.screenshot.includes("view")) {
        await screenshots.take("view", saveOutput ? data : null);
      }
      if (this.params.screenshot.includes("fullPage")) {
        await screenshots.takeFullPage();
      }
      if (this.params.screenshot.includes("thumbnail")) {
        await screenshots.takeThumbnail();
      }
    }

    let textextract = null;

    if (this.textWriter) {
      textextract = new TextExtractViaSnapshot(cdp, {
        writer: this.textWriter,
        url,
        skipDocs: this.skipTextDocs,
      });
      const { text } = await textextract.extractAndStoreText(
        "text",
        false,
        this.params.text.includes("to-warc"),
      );

      if (text !== null && (this.textInPages || saveOutput)) {
        data.text = text;
      }
    }

    data.loadState = LoadState.EXTRACTION_DONE;

    if (this.params.behaviorOpts && data.status < 400) {
      if (data.skipBehaviors) {
        logger.info("Skipping behaviors for slow page", logDetails, "behavior");
      } else {
        const res = await timedRun(
          this.runBehaviors(
            page,
            cdp,
            data.filteredFrames,
            opts.frameIdToExecId,
            logDetails,
          ),
          this.params.behaviorTimeout,
          "Behaviors timed out",
          logDetails,
          "behavior",
          true,
        );

        await this.netIdle(page, logDetails);

        if (res) {
          data.loadState = LoadState.BEHAVIORS_DONE;
        }

        if (textextract && this.params.text.includes("final-to-warc")) {
          await textextract.extractAndStoreText("textFinal", true, true);
        }
      }
    }
  }

  async awaitPageExtraDelay(opts: WorkerState) {
    if (this.params.pageExtraDelay) {
      const {
        data: { url: page },
        workerid,
      } = opts;

      const logDetails = { page, workerid };

      logger.info(
        `Waiting ${this.params.pageExtraDelay} seconds before moving on to next page`,
        logDetails,
      );
      await sleep(this.params.pageExtraDelay);
    }
  }

  async pageFinished(data: PageState) {
    await this.writePage(data);

    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      logger.info("Page Finished", { loadState, ...logDetails }, "pageStatus");

      await this.crawlState.markFinished(data.url);

      if (this.healthChecker) {
        this.healthChecker.resetErrors();
      }
    } else {
      await this.crawlState.markFailed(data.url);

      if (this.healthChecker) {
        this.healthChecker.incError();
      }
    }

    await this.serializeConfig();

    await this.checkLimits();
  }

  async teardownPage({ workerid }: WorkerOpts) {
    if (this.screencaster) {
      await this.screencaster.stopById(workerid);
    }
  }

  async workerIdle(workerid: WorkerId) {
    if (this.screencaster) {
      //logger.debug("End Screencast", {workerid}, "screencast");
      await this.screencaster.stopById(workerid, true);
    }
  }

  async runBehaviors(
    page: Page,
    cdp: CDPSession,
    frames: Frame[],
    frameIdToExecId: Map<string, number>,
    logDetails: LogDetails,
  ) {
    try {
      frames = frames || page.frames();

      logger.info(
        "Running behaviors",
        {
          frames: frames.length,
          frameUrls: frames.map((frame) => frame.url()),
          ...logDetails,
        },
        "behavior",
      );

      const results = await Promise.allSettled(
        frames.map((frame) =>
          this.browser.evaluateWithCLI(
            cdp,
            frame,
            frameIdToExecId,
            `
          if (!self.__bx_behaviors) {
            console.error("__bx_behaviors missing, can't run behaviors");
          } else {
            self.__bx_behaviors.run();
          }`,
            logDetails,
            "behavior",
          ),
        ),
      );

      for (const res of results) {
        const { status, reason }: { status: string; reason?: unknown } = res;
        if (status === "rejected") {
          logger.warn(
            "Behavior run partially failed",
            { reason: formatErr(reason), ...logDetails },
            "behavior",
          );
        }
      }

      logger.info(
        "Behaviors finished",
        { finished: results.length, ...logDetails },
        "behavior",
      );
      return true;
    } catch (e) {
      logger.warn(
        "Behavior run failed",
        { ...formatErr(e), ...logDetails },
        "behavior",
      );
      return false;
    }
  }

  async shouldIncludeFrame(frame: Frame, logDetails: LogDetails) {
    if (!frame.parentFrame()) {
      return frame;
    }

    const frameUrl = frame.url();

    if (!frameUrl) {
      return null;
    }

    // this is all designed to detect and skip PDFs, and other frames that are actually EMBEDs
    // if there's no tag or an iframe tag, then assume its a regular frame
    let tagName = "";

    try {
      tagName = await timedRun(
        frame.evaluate(
          "self && self.frameElement && self.frameElement.tagName",
        ),
        PAGE_OP_TIMEOUT_SECS,
        "Frame check timed out",
        logDetails,
      );
    } catch (e) {
      // ignore
    }

    if (tagName && tagName !== "IFRAME" && tagName !== "FRAME") {
      logger.debug(
        "Skipping processing non-frame object",
        { tagName, frameUrl, ...logDetails },
        "behavior",
      );
      return null;
    }

    let res;

    if (frameUrl === "about:blank") {
      res = false;
    } else {
      res = this.adBlockRules && !this.adBlockRules.isAdUrl(frameUrl);
    }

    if (!res) {
      logger.debug(
        "Skipping processing frame",
        { frameUrl, ...logDetails },
        "behavior",
      );
    }

    return res ? frame : null;
  }

  async checkLimits() {
    let interrupt = false;

    const size = this.params.dryRun ? 0 : await getDirSize(this.archivesDir);

    await this.crawlState.setArchiveSize(size);

    if (this.params.sizeLimit) {
      if (size >= this.params.sizeLimit) {
        logger.info(
          `Size threshold reached ${size} >= ${this.params.sizeLimit}, stopping`,
        );
        interrupt = true;
      }
    }

    if (this.params.timeLimit) {
      const elapsed = secondsElapsed(this.startTime);
      if (elapsed >= this.params.timeLimit) {
        logger.info(
          `Time threshold reached ${elapsed} > ${this.params.timeLimit}, stopping`,
        );
        interrupt = true;
      }
    }

    if (this.params.diskUtilization) {
      // Check that disk usage isn't already or soon to be above threshold
      const diskUtil = await checkDiskUtilization(
        this.collDir,
        this.params,
        size,
      );
      if (diskUtil.stop === true) {
        interrupt = true;
      }
    }

    if (this.params.failOnFailedLimit) {
      const numFailed = await this.crawlState.numFailed();
      const failedLimit = this.params.failOnFailedLimit;
      if (numFailed >= failedLimit) {
        logger.fatal(
          `Failed threshold reached ${numFailed} >= ${failedLimit}, failing crawl`,
        );
      }
    }

    if (interrupt) {
      this.uploadAndDeleteLocal = true;
      this.gracefulFinishOnInterrupt();
    }
  }

  gracefulFinishOnInterrupt() {
    this.interrupted = true;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (!this.params.waitOnDone && !this.params.restartsOnError) {
      this.finalExit = true;
    }
  }

  async checkCanceled() {
    if (this.crawlState && (await this.crawlState.isCrawlCanceled())) {
      await this.setStatusAndExit(0, "canceled");
    }
  }

  async setStatusAndExit(exitCode: number, status: string) {
    logger.info(`Exiting, Crawl status: ${status}`);

    await this.closeLog();

    if (this.crawlState && status) {
      await this.crawlState.setStatus(status);
    }
    process.exit(exitCode);
  }

  async serializeAndExit() {
    await this.serializeConfig();

    if (this.interrupted) {
      await this.browser.close();
      await closeWorkers(0);
      await this.closeFiles();
      if (!this.done) {
        await this.setStatusAndExit(13, "interrupted");
        return;
      }
    }
    await this.setStatusAndExit(0, "done");
  }

  async isCrawlRunning() {
    if (this.interrupted) {
      return false;
    }

    if (await this.crawlState.isCrawlCanceled()) {
      await this.setStatusAndExit(0, "canceled");
      return false;
    }

    if (await this.crawlState.isCrawlStopped()) {
      logger.info("Crawler is stopped");
      return false;
    }

    return true;
  }

  async crawl() {
    if (this.params.healthCheckPort) {
      this.healthChecker = new HealthChecker(
        this.params.healthCheckPort,
        this.params.workers,
      );
    }

    try {
      const driverUrl = new URL(this.params.driver, import.meta.url);
      this.driver = (await import(driverUrl.href)).default;
    } catch (e) {
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

    if (POST_CRAWL_STATES.includes(initState)) {
      logger.info("crawl already finished, running post-crawl tasks", {
        state: initState,
      });
      await this.postCrawl();
      return;
    } else if (await this.crawlState.isCrawlStopped()) {
      logger.info("crawl stopped, running post-crawl tasks");
      this.finalExit = true;
      await this.postCrawl();
      return;
    } else if (await this.crawlState.isCrawlCanceled()) {
      logger.info("crawl canceled, will exit");
      return;
    }

    await this.crawlState.setStatus("running");

    this.pagesFH = await this.initPages(this.seedPagesFile, "Seed Pages");
    this.extraPagesFH = await this.initPages(
      this.otherPagesFile,
      "Non-Seed Pages",
    );

    this.adBlockRules = new AdBlockRules(
      this.captureBasePrefix,
      this.params.adBlockMessage,
    );

    if (this.params.blockRules && this.params.blockRules.length) {
      this.blockRules = new BlockRules(
        this.params.blockRules,
        this.captureBasePrefix,
        this.params.blockMessage,
      );
    }

    this.screencaster = this.initScreenCaster();

    if (this.params.originOverride && this.params.originOverride.length) {
      this.originOverride = new OriginOverride(this.params.originOverride);
    }

    await this._addInitialSeeds();

    await this.browser.launch({
      profileUrl: this.params.profile,
      headless: this.params.headless,
      emulateDevice: this.emulateDevice,
      swOpt: this.params.serviceWorker,
      chromeOptions: {
        proxy: this.proxyServer,
        userAgent: this.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ondisconnect: (err: any) => {
        this.interrupted = true;
        logger.error(
          "Browser disconnected (crashed?), interrupting crawl",
          err,
          "browser",
        );
      },

      recording: this.recording,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // --------------
    // Run Crawl Here!
    await runWorkers(this, this.params.workers, this.maxPageTime);
    // --------------

    await this.serializeConfig(true);

    await this.closePages();

    await this.closeFiles();

    await this.writeStats();

    // if crawl has been stopped, mark as final exit for post-crawl tasks
    if (await this.crawlState.isCrawlStopped()) {
      this.finalExit = true;
    }

    await this.postCrawl();
  }

  async closePages() {
    if (this.pagesFH) {
      try {
        await new Promise<void>((resolve) =>
          this.pagesFH!.close(() => resolve()),
        );
      } catch (e) {
        // ignore
      } finally {
        this.pagesFH = null;
      }
    }

    if (this.extraPagesFH) {
      try {
        await new Promise<void>((resolve) =>
          this.extraPagesFH!.close(() => resolve()),
        );
      } catch (e) {
        // ignore
      } finally {
        this.extraPagesFH = null;
      }
    }
  }

  async closeFiles() {
    if (this.textWriter) {
      await this.textWriter.flush();
    }
    if (this.screenshotWriter) {
      await this.screenshotWriter.flush();
    }
  }

  protected async _addInitialSeeds() {
    for (let i = 0; i < this.seeds.length; i++) {
      const seed = this.seeds[i];
      if (!(await this.queueUrl(i, seed.url, 0, 0))) {
        if (this.limitHit) {
          break;
        }
      }

      if (seed.sitemap) {
        await timedRun(
          this.parseSitemap(seed, i),
          SITEMAP_INITIAL_FETCH_TIMEOUT_SECS,
          "Sitemap initial fetch timed out",
          { sitemap: seed.sitemap, seed: seed.url },
          "sitemap",
        );
      }
    }
  }

  async postCrawl() {
    if (this.params.combineWARC && !this.params.dryRun) {
      await this.combineWARC();
    }

    logger.info("Crawling done");

    if (
      (this.params.generateCDX || this.params.generateWACZ) &&
      !this.params.dryRun
    ) {
      logger.info("Merging CDX");
      await this.crawlState.setStatus(
        this.params.generateWACZ ? "generate-wacz" : "generate-cdx",
      );

      await mergeCDXJ(this.tempCdxDir, this.indexesDir, false);
    }

    if (
      this.params.generateWACZ &&
      !this.params.dryRun &&
      (!this.interrupted || this.finalExit || this.uploadAndDeleteLocal)
    ) {
      const uploaded = await this.generateWACZ();

      if (uploaded && this.uploadAndDeleteLocal) {
        logger.info(
          `Uploaded WACZ, deleting local data to free up space: ${this.collDir}`,
        );
        try {
          fs.rmSync(this.collDir, { recursive: true, force: true });
        } catch (e) {
          logger.warn(`Unable to clear ${this.collDir} before exit`, e);
        }
      }
    }

    // remove tmp-cdx, now that it's already been added to the WACZ and/or
    // copied to indexes
    // await fsp.rm(this.tempCdxDir, {
    //   recursive: true,
    //   force: true,
    // });

    if (this.params.waitOnDone && (!this.interrupted || this.finalExit)) {
      this.done = true;
      logger.info("All done, waiting for signal...");
      await this.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  async closeLog(): Promise<void> {
    // close file-based log
    logger.setExternalLogStream(null);
    if (!this.logFH) {
      return;
    }
    const logFH = this.logFH;
    this.logFH = null;
    await streamFinish(logFH);
  }

  async generateWACZ() {
    logger.info("Generating WACZ");
    await this.crawlState.setStatus("generate-wacz");

    // Get a list of the warcs inside
    const warcFileList = await fsp.readdir(this.archivesDir);

    // is finished (>0 pages and all pages written)
    const isFinished = await this.crawlState.isFinished();

    logger.info(`Num WARC Files: ${warcFileList.length}`);
    if (!warcFileList.length) {
      // if finished, just return
      if (isFinished || (await this.crawlState.isCrawlCanceled())) {
        return;
      }
      // if stopped, won't get anymore data
      if (await this.crawlState.isCrawlStopped()) {
        // possibly restarted after committing, so assume done here!
        if ((await this.crawlState.numDone()) > 0) {
          return;
        }
      }
      // fail crawl otherwise
      logger.fatal("No WARC Files, assuming crawl failed");
    }

    const waczPath = path.join(this.collDir, this.params.collection + ".wacz");

    const streaming = !!this.storage;

    if (!streaming) {
      logger.debug("WACZ will be written to disk", { path: waczPath }, "wacz");
    } else {
      logger.debug("WACZ will be stream uploaded to remote storage");
    }

    logger.debug("End of log file in WACZ, storing logs to WACZ file");

    await this.closeLog();

    const waczOpts: WACZInitOpts = {
      input: warcFileList.map((x) => path.join(this.archivesDir, x)),
      output: waczPath,
      pages: this.pagesDir,
      logDirectory: this.logDir,
      tempCdxDir: this.tempCdxDir,
      indexesDir: this.indexesDir,
      softwareString: this.infoString,
    };

    if (process.env.WACZ_SIGN_URL) {
      waczOpts.signingUrl = process.env.WACZ_SIGN_URL;
      if (process.env.WACZ_SIGN_TOKEN) {
        waczOpts.signingToken = "bearer " + process.env.WACZ_SIGN_TOKEN;
      }
    }

    if (this.params.title) {
      waczOpts.title = this.params.title;
    }

    if (this.params.description) {
      waczOpts.description = this.params.description;
    }

    let wacz: WACZ;

    try {
      wacz = new WACZ(waczOpts, this.collDir);
      if (!streaming) {
        await wacz.generateToFile(waczPath);
      }
    } catch (e) {
      logger.error("Error creating WACZ", e);
      if (!streaming) {
        logger.fatal("Unable to write WACZ successfully");
      }
    }

    if (this.storage) {
      await this.crawlState.setStatus("uploading-wacz");
      const filename = process.env.STORE_FILENAME || "@ts-@id.wacz";
      const targetFilename = interpolateFilename(filename, this.crawlId);

      await this.storage.uploadCollWACZ(wacz!, targetFilename, isFinished);
      return true;
    }

    return false;
  }

  logMemory() {
    const memUsage = process.memoryUsage();
    const { heapUsed, heapTotal } = memUsage;
    this.maxHeapUsed = Math.max(this.maxHeapUsed || 0, heapUsed);
    this.maxHeapTotal = Math.max(this.maxHeapTotal || 0, heapTotal);
    logger.debug(
      "Memory",
      {
        maxHeapUsed: this.maxHeapUsed,
        maxHeapTotal: this.maxHeapTotal,
        ...memUsage,
      },
      "memoryStatus",
    );
  }

  async writeStats() {
    if (!this.params.logging.includes("stats")) {
      return;
    }

    const realSize = await this.crawlState.queueSize();
    const pendingPages = await this.crawlState.getPendingList();
    const done = await this.crawlState.numDone();
    const failed = await this.crawlState.numFailed();
    const total = realSize + pendingPages.length + done;
    const limit = { max: this.pageLimit || 0, hit: this.limitHit };
    const stats = {
      crawled: done,
      total: total,
      pending: pendingPages.length,
      failed: failed,
      limit: limit,
      pendingPages,
    };

    logger.info("Crawl statistics", stats, "crawlStatus");
    this.logMemory();

    if (this.params.statsFilename) {
      try {
        await fsp.writeFile(
          this.params.statsFilename,
          JSON.stringify(stats, null, 2),
        );
      } catch (err) {
        logger.warn("Stats output failed", err);
      }
    }
  }

  async loadPage(
    page: Page,
    data: PageState,
    selectorOptsList = DEFAULT_SELECTORS,
  ) {
    const { url, depth } = data;

    const logDetails = data.logDetails;

    const failCrawlOnError = depth === 0 && this.params.failOnFailedSeed;

    // Attempt to load the page:
    // - Already tried direct fetch w/o browser before getting here, and that resulted in an HTML page or non-200 response
    //   so now loading using the browser
    // - If page.load() fails, but downloadResponse is set, then its a download, consider successful
    //   set page status to FULL_PAGE_LOADED (2)
    // - If page.load() fails, but firstResponse is set to CONTENT_LOADED (1) state,
    //   consider a slow page, proceed to link extraction, but skip behaviors, issue warning
    // - If page.load() fails otherwise and if failOnFailedSeed is set, fail crawl, otherwise fail page
    // - If page.load() succeeds, check if page url is a chrome-error:// page, fail page (and or crawl if failOnFailedSeed and seed)
    // - If at least one response, check if HTML, proceed with post-crawl actions only if HTML.

    let downloadResponse: HTTPResponse | null = null;
    let firstResponse: HTTPResponse | null = null;
    let fullLoadedResponse: HTTPResponse | null = null;

    // Detect if failure is actually caused by trying to load a non-page (eg. downloadable PDF),
    // store the downloadResponse, if any
    page.once("requestfailed", (req: HTTPRequest) => {
      downloadResponse = getDownloadResponse(req);
    });

    // store the first successful non-redirect response, even if page doesn't load fully
    const waitFirstResponse = (resp: HTTPResponse) => {
      firstResponse = resp;
      if (!isRedirectStatus(firstResponse.status())) {
        // don't listen to any additional responses
        page.off("response", waitFirstResponse);
      }
    };

    page.on("response", waitFirstResponse);

    // store that domcontentloaded was finished
    page.once("domcontentloaded", () => {
      data.loadState = LoadState.CONTENT_LOADED;
    });

    const gotoOpts = data.isHTMLPage
      ? this.gotoOpts
      : { waitUntil: "domcontentloaded" };

    logger.info("Awaiting page load", logDetails);

    try {
      // store the page load response when page fully loads
      fullLoadedResponse = await page.goto(url, gotoOpts);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
      const msg = e.message || "";

      // got firstResponse and content loaded, not a failure
      if (firstResponse && data.loadState == LoadState.CONTENT_LOADED) {
        // if timeout error, and at least got to content loaded, continue on
        logger.warn(
          "Page load timed out, loading but slowly, skipping behaviors",
          {
            msg,
            ...logDetails,
          },
        );
        data.skipBehaviors = true;
      } else if (!downloadResponse) {
        if (failCrawlOnError) {
          // if fail on error, immediately fail here
          logger.fatal(
            "Page Load Timeout, failing crawl",
            {
              msg,
              ...logDetails,
            },
            "general",
            1,
          );
          // log if not already log and rethrow, consider page failed
        } else if (msg !== "logged") {
          logger.error("Page Load Failed, skipping page", {
            msg,
            loadState: data.loadState,
            ...logDetails,
          });
          e.message = "logged";
        }
        throw e;
      }
    }

    const resp = fullLoadedResponse || downloadResponse || firstResponse;

    if (!resp) {
      throw new Error("no response for page load, assuming failed");
    }

    const respUrl = resp.url();
    const isChromeError = page.url().startsWith("chrome-error://");

    if (depth === 0 && !isChromeError && respUrl !== url && !downloadResponse) {
      data.seedId = await this.crawlState.addExtraSeed(
        this.seeds,
        this.numOriginalSeeds,
        data.seedId,
        respUrl,
      );
      logger.info("Seed page redirected, adding redirected seed", {
        origUrl: url,
        newUrl: respUrl,
        seedId: data.seedId,
      });
    }

    const status = resp.status();
    data.status = status;

    let failed = isChromeError;

    if (this.params.failOnInvalidStatus && status >= 400) {
      // Handle 4xx or 5xx response as a page load error
      failed = true;
    }

    if (failed) {
      if (failCrawlOnError) {
        logger.fatal(
          "Seed Page Load Error, failing crawl",
          {
            status,
            ...logDetails,
          },
          "general",
          1,
        );
      } else {
        logger.error(
          isChromeError ? "Page Crashed on Load" : "Page Invalid Status",
          {
            status,
            ...logDetails,
          },
        );
        throw new Error("logged");
      }
    }

    const contentType = resp.headers()["content-type"];

    if (contentType) {
      data.mime = contentType.split(";")[0];
      data.isHTMLPage = isHTMLMime(data.mime);
    } else {
      // guess that its html if it fully loaded as a page
      data.isHTMLPage = !!fullLoadedResponse;
    }

    // Full Page Loaded if:
    // - it was a download response
    // - page.load() succeeded
    // but not:
    // - if first response was received, but not fully loaded
    if (fullLoadedResponse || downloadResponse) {
      data.loadState = LoadState.FULL_PAGE_LOADED;
    }

    if (!data.isHTMLPage) {
      data.filteredFrames = [];

      logger.info(
        "Non-HTML Page URL, skipping all post-crawl actions",
        { isDownload: !!downloadResponse, mime: data.mime, ...logDetails },
        "pageStatus",
      );
      return;
    }

    // HTML Pages Only here
    const frames = await page.frames();

    const filteredFrames = await Promise.allSettled(
      frames.map((frame) => this.shouldIncludeFrame(frame, logDetails)),
    );

    data.filteredFrames = filteredFrames
      .filter((x: PromiseSettledResult<Frame | null>) => {
        if (x.status === "fulfilled") {
          return !!x.value;
        }
        logger.warn("Error in iframe check", {
          reason: x.reason,
          ...logDetails,
        });
        return false;
      })
      .map((x) => (x as PromiseFulfilledResult<Frame>).value);

    //data.filteredFrames = await page.frames().filter(frame => this.shouldIncludeFrame(frame, logDetails));

    const { seedId } = data;

    const seed = await this.crawlState.getSeedAt(
      this.seeds,
      this.numOriginalSeeds,
      seedId,
    );

    if (!seed) {
      logger.error(
        "Seed not found, likely invalid crawl state - skipping link extraction and behaviors",
        { seedId, ...logDetails },
      );
      return;
    }

    await this.checkCF(page, logDetails);

    await this.netIdle(page, logDetails);

    await this.awaitPageLoad(page.mainFrame(), logDetails);

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(depth) || !selectorOptsList) {
      logger.debug("Skipping Link Extraction, At Max Depth");
      return;
    }

    logger.debug("Extracting links", logDetails);

    await this.extractLinks(page, data, selectorOptsList, logDetails);
  }

  async netIdle(page: Page, details: LogDetails) {
    if (!this.params.netIdleWait) {
      return;
    }
    // in case page starts loading via fetch/xhr immediately after page load,
    // we want to ensure we don't exit too early
    await sleep(0.5);

    try {
      await this.browser.waitForNetworkIdle(page, {
        timeout: this.params.netIdleWait * 1000,
      });
    } catch (e) {
      logger.debug("waitForNetworkIdle timed out, ignoring", details);
      // ignore, continue
    }
  }

  async awaitPageLoad(frame: Frame, logDetails: LogDetails) {
    logger.debug(
      "Waiting for custom page load via behavior",
      logDetails,
      "behavior",
    );
    try {
      await frame.evaluate(
        "self.__bx_behaviors && self.__bx_behaviors.awaitPageLoad();",
      );
    } catch (e) {
      logger.warn("Waiting for custom page load failed", e, "behavior");
    }

    if (this.params.postLoadDelay) {
      logger.info("Awaiting post load delay", {
        seconds: this.params.postLoadDelay,
      });
      await sleep(this.params.postLoadDelay);
    }
  }

  async extractLinks(
    page: Page,
    data: PageState,
    selectors = DEFAULT_SELECTORS,
    logDetails: LogDetails,
  ) {
    const { seedId, depth, extraHops = 0, filteredFrames, callbacks } = data;

    callbacks.addLink = async (url: string) => {
      await this.queueInScopeUrls(
        seedId,
        [url],
        depth,
        extraHops,
        false,
        logDetails,
      );
    };

    const loadLinks = (options: {
      selector: string;
      extract: string;
      isAttribute: boolean;
      addLinkFunc: string;
    }) => {
      const { selector, extract, isAttribute, addLinkFunc } = options;
      const urls = new Set<string>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getAttr = (elem: any) => urls.add(elem.getAttribute(extract));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getProp = (elem: any) => urls.add(elem[extract]);

      const getter = isAttribute ? getAttr : getProp;

      document.querySelectorAll(selector).forEach(getter);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const func = (window as any)[addLinkFunc] as (
        url: string,
      ) => NonNullable<unknown>;
      urls.forEach((url) => func.call(this, url));

      return true;
    };

    const frames = filteredFrames || page.frames();

    try {
      for (const {
        selector = "a[href]",
        extract = "href",
        isAttribute = false,
      } of selectors) {
        const promiseResults = await Promise.allSettled(
          frames.map((frame) =>
            timedRun(
              frame.evaluate(loadLinks, {
                selector,
                extract,
                isAttribute,
                addLinkFunc: ADD_LINK_FUNC,
              }),
              PAGE_OP_TIMEOUT_SECS,
              "Link extraction timed out",
              logDetails,
            ),
          ),
        );

        for (let i = 0; i < promiseResults.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { status, reason } = promiseResults[i] as any;
          if (status === "rejected") {
            logger.warn("Link Extraction failed in frame", {
              reason,
              frameUrl: frames[i].url,
              ...logDetails,
            });
          }
        }
      }
    } catch (e) {
      logger.warn("Link Extraction failed", e, "links");
    }
  }

  async queueInScopeUrls(
    seedId: number,
    urls: string[],
    depth: number,
    extraHops = 0,
    noOOS = false,
    logDetails: LogDetails = {},
  ) {
    try {
      depth += 1;

      // new number of extra hops, set if this hop is out-of-scope (oos)
      const newExtraHops = extraHops + 1;

      for (const possibleUrl of urls) {
        const res = this.getScope(
          { url: possibleUrl, extraHops: newExtraHops, depth, seedId, noOOS },
          logDetails,
        );

        if (!res) {
          continue;
        }

        const { url, isOOS } = res;

        if (url) {
          await this.queueUrl(
            seedId,
            url,
            depth,
            isOOS ? newExtraHops : extraHops,
            logDetails,
          );
        }
      }
    } catch (e) {
      logger.error("Queuing Error", e, "links");
    }
  }

  async checkCF(page: Page, logDetails: LogDetails) {
    try {
      logger.debug("Check CF Blocking", logDetails);

      while (
        await timedRun(
          page.$("div.cf-browser-verification.cf-im-under-attack"),
          PAGE_OP_TIMEOUT_SECS,
          "Cloudflare check timed out",
          logDetails,
          "general",
          true,
        )
      ) {
        logger.debug(
          "Cloudflare Check Detected, waiting for reload...",
          logDetails,
        );
        await sleep(5.5);
      }
    } catch (e) {
      //logger.warn("Check CF failed, ignoring");
    }
  }

  async queueUrl(
    seedId: number,
    url: string,
    depth: number,
    extraHops: number,
    logDetails: LogDetails = {},
    ts = 0,
    pageid?: string,
  ) {
    if (this.limitHit) {
      return false;
    }

    const result = await this.crawlState.addToQueue(
      { url, seedId, depth, extraHops, ts, pageid },
      this.pageLimit,
    );

    switch (result) {
      case QueueState.ADDED:
        logger.debug("Queued new page url", { url, ...logDetails }, "links");
        return true;

      case QueueState.LIMIT_HIT:
        logger.debug(
          "Not queued page url, at page limit",
          { url, ...logDetails },
          "links",
        );
        this.limitHit = true;
        return false;

      case QueueState.DUPE_URL:
        logger.debug(
          "Not queued page url, already seen",
          { url, ...logDetails },
          "links",
        );
        return false;
    }

    return false;
  }

  async initPages(filename: string, title: string) {
    let fh = null;

    try {
      await fsp.mkdir(this.pagesDir, { recursive: true });

      const createNew = !fs.existsSync(filename);

      fh = fs.createWriteStream(filename, { flags: "a" });

      if (createNew) {
        const header: Record<string, string> = {
          format: "json-pages-1.0",
          id: "pages",
          title,
        };
        header.hasText = this.params.text.includes("to-pages");
        if (this.params.text.length) {
          logger.debug("Text Extraction: " + this.params.text.join(","));
        } else {
          logger.debug("Text Extraction: None");
        }
        await fh.write(JSON.stringify(header) + "\n");
      }
    } catch (err) {
      logger.error(`"${filename}" creation failed`, err);
    }
    return fh;
  }

  protected pageEntryForRedis(
    entry: Record<string, string | number | boolean | object>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    state: PageState,
  ) {
    return entry;
  }

  async writePage(state: PageState) {
    const {
      pageid,
      url,
      depth,
      title,
      text,
      loadState,
      mime,
      favicon,
      status,
    } = state;

    const row: PageEntry = { id: pageid, url, title, loadState };

    let { ts } = state;
    if (!ts) {
      ts = new Date();
      if (!this.params.dryRun) {
        logger.warn(
          "Page date missing, setting to now",
          { url, ts },
          "pageStatus",
        );
      }
    }

    row.ts = ts.toISOString();

    if (mime) {
      row.mime = mime;
    }

    if (status) {
      row.status = status;
    }

    if (this.params.writePagesToRedis) {
      await this.crawlState.writeToPagesQueue(
        JSON.stringify(this.pageEntryForRedis(row, state)),
      );
    }

    if (depth === 0) {
      row.seed = true;
    }

    if (text && this.textInPages) {
      row.text = text;
    }

    if (favicon) {
      row.favIconUrl = favicon;
    }

    const processedRow = JSON.stringify(row) + "\n";

    const pagesFH = depth > 0 ? this.extraPagesFH : this.pagesFH;

    if (!pagesFH) {
      logger.error("Can't write pages, missing stream", {}, "pageStatus");
      return;
    }

    try {
      await pagesFH.write(processedRow);
    } catch (err) {
      logger.warn(
        "Page append failed",
        { pagesFile: depth > 0 ? this.otherPagesFile : this.seedPagesFile },
        "pageStatus",
      );
    }
  }

  async parseSitemap({ url, sitemap }: ScopedSeed, seedId: number) {
    if (!sitemap) {
      return;
    }

    if (await this.crawlState.isSitemapDone()) {
      logger.info("Sitemap already processed, skipping", "sitemap");
      return;
    }

    const fromDate = this.params.sitemapFromDate;
    const toDate = this.params.sitemapToDate;
    const headers = this.headers;

    logger.info(
      "Fetching sitemap",
      { from: fromDate || "<any date>", to: fromDate || "<any date>" },
      "sitemap",
    );
    const sitemapper = new SitemapReader({
      headers,
      fromDate,
      toDate,
      limit: this.pageLimit,
    });

    try {
      await sitemapper.parse(sitemap, url);
    } catch (e) {
      logger.warn(
        "Sitemap for seed failed",
        { url, sitemap, ...formatErr(e) },
        "sitemap",
      );
      return;
    }

    let power = 1;
    let resolved = false;

    let finished = false;

    await new Promise<void>((resolve) => {
      sitemapper.on("end", () => {
        resolve();
        if (!finished) {
          logger.info(
            "Sitemap Parsing Finished",
            { urlsFound: sitemapper.count, limitHit: sitemapper.atLimit() },
            "sitemap",
          );
          this.crawlState.markSitemapDone();
          finished = true;
        }
      });

      sitemapper.on("url", ({ url }) => {
        const count = sitemapper.count;
        if (count % 10 ** power === 0) {
          if (count % 10 ** (power + 1) === 0 && power <= 3) {
            power++;
          }
          const sitemapsQueued = sitemapper.getSitemapsQueued();
          logger.debug(
            "Sitemap URLs processed so far",
            { count, sitemapsQueued },
            "sitemap",
          );
        }
        this.queueInScopeUrls(seedId, [url], 0, 0, true);
        if (count >= 100 && !resolved) {
          logger.info(
            "Sitemap partially parsed, continue parsing large sitemap in the background",
            { urlsFound: count },
            "sitemap",
          );
          resolve();
          resolved = true;
        }
      });
    });
  }

  async combineWARC() {
    logger.info("Generating Combined WARCs");
    await this.crawlState.setStatus("generate-warc");

    // Get the list of created Warcs
    const warcLists = await fsp.readdir(this.archivesDir);

    logger.debug(`Combining ${warcLists.length} WARCs...`);

    const fileSizeObjects = []; // Used to sort the created warc by fileSize

    // Go through a list of the created works and create an array sorted by their filesize with the largest file first.
    for (let i = 0; i < warcLists.length; i++) {
      const fileName = path.join(this.archivesDir, warcLists[i]);
      const fileSize = await getFileSize(fileName);
      fileSizeObjects.push({ fileSize: fileSize, fileName: fileName });
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
        const proposedWarcSize =
          fileSizeObjects[j].fileSize + currentCombinedWarcSize;

        doRollover = proposedWarcSize >= this.params.rolloverSize;
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

        fh = fs.createWriteStream(combinedWarcFullPath, { flags: "a" });

        generatedCombinedWarcs.push(combinedWarcName);

        const warcBuffer = await createWARCInfo(combinedWarcName);
        fh.write(warcBuffer);
      }

      logger.debug(`Appending WARC ${fileSizeObjects[j].fileName}`);

      const reader = fs.createReadStream(fileSizeObjects[j].fileName);

      const p = new Promise<void>((resolve) => {
        reader.on("end", () => resolve());
      });

      if (fh) {
        reader.pipe(fh, { end: false });
      }

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
      if (
        secondsElapsed(this.lastSaveTime, now) < this.params.saveStateInterval
      ) {
        return;
      }
    }

    this.lastSaveTime = now.getTime();

    const ts = now.toISOString().slice(0, 19).replace(/[T:-]/g, "");

    const crawlDir = path.join(this.collDir, "crawls");

    await fsp.mkdir(crawlDir, { recursive: true });

    const filenameOnly = `crawl-${ts}-${this.params.crawlId}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.crawlState.serialize();

    if (this.origConfig) {
      this.origConfig.state = state;
    }
    const res = yaml.dump(this.origConfig, { lineWidth: -1 });
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
        await fsp.unlink(oldFilename || "");
      } catch (e) {
        logger.error(`Failed to delete old save state file: ${oldFilename}`);
      }
    }

    if (this.storage && done && this.params.saveState === "always") {
      const targetFilename = interpolateFilename(filenameOnly, this.crawlId);

      await this.storage.uploadFile(filename, targetFilename);
    }
  }

  getWarcPrefix(defaultValue = "") {
    let warcPrefix =
      process.env.WARC_PREFIX || this.params.warcPrefix || defaultValue;

    if (warcPrefix) {
      warcPrefix += "-" + this.crawlId + "-";
    }

    return warcPrefix;
  }

  createExtraResourceWarcWriter(resourceName: string, gzip = true) {
    const filenameBase = `${this.getWarcPrefix()}${resourceName}-$ts`;

    return this.createWarcWriter(filenameBase, gzip, { resourceName });
  }

  createWarcWriter(
    filenameBase: string,
    gzip: boolean,
    logDetails: Record<string, string>,
  ) {
    const filenameTemplate = `${filenameBase}.warc${gzip ? ".gz" : ""}`;

    return new WARCWriter({
      archivesDir: this.archivesDir,
      tempCdxDir: this.tempCdxDir,
      filenameTemplate,
      rolloverSize: this.params.rolloverSize,
      gzip,
      logDetails,
    });
  }

  createRecorder(id: number): Recorder | null {
    if (!this.recording) {
      return null;
    }

    const filenameBase = `${this.getWarcPrefix("rec")}$ts-${id}`;

    const writer = this.createWarcWriter(filenameBase, true, {
      id: id.toString(),
    });

    const res = new Recorder({
      workerid: id,
      crawler: this,
      writer,
      tempdir: this.tempdir,
    });

    this.browser.recorders.push(res);
    return res;
  }
}

function getDownloadResponse(req: HTTPRequest) {
  try {
    if (!req.isNavigationRequest()) {
      return null;
    }

    const failure = req.failure();
    const failureText = (failure && failure.errorText) || "";
    if (
      failureText !== "net::ERR_ABORTED" ||
      req.resourceType() !== "document"
    ) {
      return null;
    }

    const resp = req.response();

    if (!resp) {
      return null;
    }

    const headers = resp.headers();

    if (
      headers["content-disposition"] ||
      (headers["content-type"] && !isHTMLMime(headers["content-type"]))
    ) {
      return resp;
    }
  } catch (e) {
    console.log(e);
    // ignore
  }

  return null;
}
