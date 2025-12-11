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

import { CrawlerArgs, parseArgs } from "./util/argParser.js";

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
  isDiskFull,
} from "./util/storage.js";
import { ScreenCaster, WSTransport } from "./util/screencaster.js";
import { Screenshots } from "./util/screenshots.js";
import { initRedis } from "./util/redis.js";
import { logger, formatErr, LogDetails, LogContext } from "./util/logger.js";
import { WorkerState, closeWorkers, runWorkers } from "./util/worker.js";
import { sleep, timedRun, secondsElapsed } from "./util/timing.js";
import { collectCustomBehaviors, getInfoString } from "./util/file_reader.js";

import { Browser } from "./util/browser.js";

import {
  DISPLAY,
  ExtractSelector,
  PAGE_OP_TIMEOUT_SECS,
  SITEMAP_INITIAL_FETCH_TIMEOUT_SECS,
  ExitCodes,
  InterruptReason,
  BxFunctionBindings,
  MAX_JS_DIALOG_PER_PAGE,
} from "./util/constants.js";

import { AdBlockRules, BlockRuleDecl, BlockRules } from "./util/blockrules.js";
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
import { ScopedSeed, parseSeeds } from "./util/seeds.js";
import {
  WARCWriter,
  createWARCInfo,
  setWARCInfo,
  streamFinish,
} from "./util/warcwriter.js";
import { isHTMLMime, isRedirectStatus } from "./util/reqresp.js";
import { initProxy } from "./util/proxy.js";
import { initFlow, nextFlowStep } from "./util/flowbehavior.js";
import { isDisallowedByRobots, setRobotsConfig } from "./util/robots.js";

const btrixBehaviors = fs.readFileSync(
  new URL(
    "../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url,
  ),
  { encoding: "utf8" },
);

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
  depth?: number;
};

// ============================================================================
export class Crawler {
  params: CrawlerArgs;
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

  seeds: ScopedSeed[] = [];
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
  warcCdxDir: string;
  indexesDir: string;

  downloadsDir: string;

  screenshotWriter: WARCWriter | null;
  textWriter: WARCWriter | null;

  blockRules: BlockRules | null;
  adBlockRules: AdBlockRules | null;

  healthChecker: HealthChecker | null = null;
  originOverride: OriginOverride | null = null;

  screencaster: ScreenCaster | null = null;

  skipTextDocs = 0;

  interruptReason: InterruptReason | null = null;
  finalExit = false;
  uploadAndDeleteLocal = false;
  done = false;
  postCrawling = false;

  textInPages = false;

  customBehaviors = "";
  behaviorsChecked = false;

  browser: Browser;
  storage: S3StorageSync | null = null;

  maxHeapUsed = 0;
  maxHeapTotal = 0;

  proxyServer?: string;
  proxyPacUrl?: string;

  driver:
    | ((opts: {
        page: Page;
        data: PageState;
        seed: ScopedSeed;
        // eslint-disable-next-line no-use-before-define
        crawler: Crawler;
      }) => Promise<void>)
    | null = null;

  recording: boolean;

  constructor() {
    const args = this.parseArgs();
    this.params = args as CrawlerArgs;
    this.origConfig = this.params.origConfig;

    this.crawlId = this.params.crawlId;

    // root collections dir
    this.collDir = path.join(
      this.params.cwd,
      "collections",
      this.params.collection,
    );
    this.logDir = path.join(this.collDir, "logs");
    this.logFilename = path.join(
      this.logDir,
      `${interpolateFilename("@ts", "")}.log`,
    );

    const debugLogging = this.params.logging.includes("debug");
    logger.setDebugLogging(debugLogging);
    logger.setLogLevel(this.params.logLevel);
    logger.setContext(this.params.logContext);
    logger.setExcludeContext(this.params.logExcludeContext);

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

    // sum of page load + behavior timeouts + 2 x pageop timeouts (for cloudflare, link extraction) + extra page delay
    // if exceeded, will interrupt and move on to next page (likely behaviors or some other operation is stuck)
    this.maxPageTime =
      this.params.pageLoadTimeout +
      this.params.behaviorTimeout +
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

    // indexes dirs
    this.warcCdxDir = path.join(this.collDir, "warc-cdx");
    this.indexesDir = path.join(this.collDir, "indexes");

    // download dirs
    this.downloadsDir = path.join(this.collDir, "downloads");

    this.screenshotWriter = null;
    this.textWriter = null;

    this.blockRules = null;
    this.adBlockRules = null;

    this.healthChecker = null;

    this.interruptReason = null;
    this.finalExit = false;
    this.uploadAndDeleteLocal = false;

    this.textInPages = this.params.text.includes("to-pages");

    this.done = false;

    this.customBehaviors = "";

    this.browser = new Browser(this.collDir);
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
      this.crawlId,
      this.maxPageTime,
      os.hostname(),
      this.params.maxPageRetries,
    );

    if (this.params.logErrorsToRedis) {
      logger.setLogErrorsToRedis(true);
    }

    if (this.params.logBehaviorsToRedis) {
      logger.setLogBehaviorsToRedis(true);
    }

    if (this.params.logErrorsToRedis || this.params.logBehaviorsToRedis) {
      logger.setCrawlState(this.crawlState);
    }

    // if automatically restarts on error exit code,
    // exit with 0 from fatal by default, to avoid unnecessary restart
    // otherwise, exit with default fatal exit code
    if (this.params.restartsOnError) {
      logger.setDefaultFatalExitCode(0);
    }

    return this.crawlState;
  }

  async loadCrawlState() {
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

    return new ScreenCaster(
      transport,
      this.params.workers,
      this.browser.screenWHRatio,
    );
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
      cwd: os.tmpdir(),
      stdio: redisStdio,
      detached: RUN_DETACHED,
    });
  }

  async bootstrap() {
    if (await isDiskFull(this.params.cwd)) {
      logger.fatal(
        "Out of disk space, exiting",
        {},
        "general",
        ExitCodes.OutOfSpace,
      );
    }

    const subprocesses: ChildProcess[] = [];

    const redisUrl = this.params.redisStoreUrl || "redis://localhost:6379/0";

    if (
      redisUrl.startsWith("redis://localhost:") ||
      redisUrl.startsWith("redis://127.0.0.1:")
    ) {
      subprocesses.push(this.launchRedis());
    }

    await this.initCrawlState();

    await fsp.mkdir(this.logDir, { recursive: true });

    if (!this.params.dryRun) {
      await fsp.mkdir(this.archivesDir, { recursive: true });
      await fsp.mkdir(this.warcCdxDir, { recursive: true });
    }

    await fsp.mkdir(this.downloadsDir, { recursive: true });

    this.logFH = fs.createWriteStream(this.logFilename, { flags: "a" });
    logger.setExternalLogStream(this.logFH);

    this.infoString = await getInfoString();
    setWARCInfo(this.infoString, this.params.warcInfo);
    logger.info(this.infoString);

    const res = await initProxy(this.params, RUN_DETACHED);
    this.proxyServer = res.proxyServer;
    this.proxyPacUrl = res.proxyPacUrl;

    this.seeds = await parseSeeds(this.downloadsDir, this.params);
    this.numOriginalSeeds = this.seeds.length;

    logger.info("Seeds", this.seeds);

    logger.info("Link Selectors", this.params.selectLinks);

    if (this.params.behaviorOpts) {
      logger.info("Behavior Options", this.params.behaviorOpts);
    } else {
      logger.info("Behaviors disabled");
    }

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
      this.customBehaviors = await this.loadCustomBehaviors(
        this.params.customBehaviors,
      );
    }

    this.headers = { "User-Agent": this.configureUA() };

    if (this.params.robots) {
      setRobotsConfig(this.headers, this.crawlState);
    }

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

    await this.loadCrawlState();

    await this.crawlState.trimToLimit(this.pageLimit);
  }

  extraChromeArgs() {
    const args: string[] = [];
    if (this.params.lang) {
      if (this.params.profile) {
        logger.warn(
          "Ignoring --lang option with profile, using language configured in the profile",
          { lang: this.params.lang },
        );
      } else {
        args.push(`--accept-lang=${this.params.lang}`);
      }
    }

    const extra = this.params.extraChromeArgs;
    if (Array.isArray(extra) && extra.length > 0) {
      for (const v of extra) {
        if (v) {
          args.push(String(v));
        }
      }
    }

    return args;
  }

  async run() {
    await this.bootstrap();

    let status = "done";
    let exitCode = ExitCodes.Success;

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
        } else if (this.interruptReason) {
          status = "interrupted";
          switch (this.interruptReason) {
            case InterruptReason.SizeLimit:
              exitCode = ExitCodes.SizeLimit;
              break;
            case InterruptReason.BrowserCrashed:
              exitCode = ExitCodes.BrowserCrashed;
              break;
            case InterruptReason.SignalInterrupted:
              exitCode = ExitCodes.SignalInterrupted;
              break;
            case InterruptReason.DiskUtilization:
              exitCode = ExitCodes.DiskUtilization;
              break;
            case InterruptReason.FailedLimit:
              exitCode = ExitCodes.FailedLimit;
              break;
            case InterruptReason.TimeLimit:
              exitCode = ExitCodes.TimeLimit;
              break;
          }
        }
      }
      if (await this.crawlState.isFailed()) {
        logger.error("Crawl failed, no pages crawled successfully");
        status = "failed";
        exitCode = ExitCodes.Failed;
      }
    } catch (e) {
      logger.error("Crawl failed", e);
      exitCode = ExitCodes.Failed;
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
    let message;
    let details;

    const logDetails = { page: pageUrl, workerid };

    let context: LogContext = "behaviorScript";

    if (typeof data === "string") {
      message = data;
      details = logDetails;
    } else {
      switch (type) {
        case "error":
          message = "Behavior error";
          break;
        case "debug":
          message = "Behavior debug";
          break;
        default:
          message = "Behavior log";
      }
      details =
        typeof data === "object"
          ? { ...(data as object), ...logDetails }
          : logDetails;

      if (typeof data === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const objData = data as any;
        if (objData.siteSpecific) {
          context = "behaviorScriptCustom";
          delete objData.siteSpecific;
        }
        message = objData.msg || message;
        delete objData.msg;
        details = { ...objData, ...logDetails };
      } else {
        details = logDetails;
      }
    }

    switch (type) {
      case "info":
        logger.info(message, details, context);
        break;

      case "error":
        logger.error(message, details, context);
        break;

      case "debug":
      default:
        logger.debug(message, details, context);
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

  async setupPage(opts: WorkerState) {
    const { page, cdp, workerid, callbacks, frameIdToExecId, recorder } = opts;

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
      BxFunctionBindings.AddLinkFunc,
      (url: string) => callbacks.addLink && callbacks.addLink(url),
    );

    // used for both behaviors and link extraction now
    await this.browser.addInitScript(page, btrixBehaviors);

    if (this.params.behaviorOpts) {
      await page.exposeFunction(
        BxFunctionBindings.BehaviorLogFunc,
        (logdata: { data: string; type: string }) =>
          this._behaviorLog(logdata, page.url(), workerid),
      );

      const initScript = `
self.__bx_behaviors.init(${this.params.behaviorOpts}, false);
${this.customBehaviors}
self.__bx_behaviors.selectMainBehavior();
`;
      if (!this.behaviorsChecked && this.customBehaviors) {
        await this.checkBehaviorScripts(cdp);
        this.behaviorsChecked = true;
      }

      await page.exposeFunction(BxFunctionBindings.FetchFunc, (url: string) => {
        return recorder ? recorder.addExternalFetch(url, cdp) : false;
      });

      await this.browser.addInitScript(page, initScript);
    }

    let dialogCount = 0;

    // Handle JS dialogs:
    // - Ensure off-page navigation is canceled while behavior is running
    // - dismiss close all other dialogs if not blocking unload
    page.on("dialog", async (dialog) => {
      let accepted = true;
      let msg = {};
      try {
        if (dialog.type() === "beforeunload") {
          if (opts.pageBlockUnload) {
            accepted = false;
          }
        } else {
          // other JS dialog, just dismiss
          accepted = false;
          if (dialogCount >= MAX_JS_DIALOG_PER_PAGE) {
            // dialog likely in a loop, need to crash page to avoid being stuck
            logger.error(
              "JS Dialog appears to be in a loop, crashing page to continue",
            );
            await cdp.send("Page.crash");
            return;
          }
          dialogCount++;
        }
        msg = {
          accepted,
          blockingUnload: opts.pageBlockUnload,
          message: dialog.message(),
          type: dialog.type(),
          page: page.url(),
          workerid,
        };
        if (accepted) {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
        logger.debug("JS Dialog", msg);
      } catch (e) {
        logger.warn("JS Dialog Error", { ...msg, ...formatErr(e) });
      }
    });

    // only add if running with autoclick behavior
    if (this.params.behaviors.includes("autoclick")) {
      // Close any windows opened during navigation from autoclick
      await cdp.send("Target.setDiscoverTargets", { discover: true });

      cdp.on("Target.targetCreated", async (params) => {
        const { targetInfo } = params;
        const { type, openerFrameId, targetId } = targetInfo;

        try {
          if (
            type === "page" &&
            openerFrameId &&
            opts.frameIdToExecId.has(openerFrameId)
          ) {
            await cdp.send("Target.closeTarget", { targetId });
          } else {
            logger.warn("Extra target not closed", { targetInfo });
          }

          await cdp.send("Runtime.runIfWaitingForDebugger");
        } catch (e) {
          // target likely already closed
        }
      });

      void cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });

      if (this.recording) {
        await cdp.send("Page.enable");

        cdp.on("Page.windowOpen", async (params) => {
          const { seedId, depth, extraHops = 0, url } = opts.data;

          const logDetails = { page: url, workerid };

          await this.queueInScopeUrls(
            seedId,
            [params.url],
            depth,
            extraHops,
            false,
            logDetails,
          );
        });
      }
    }

    await page.exposeFunction(BxFunctionBindings.AddToSeenSet, (data: string) =>
      this.crawlState.addToUserSet(data),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.exposeFunction(BxFunctionBindings.InitFlow, (params: any) => {
      return initFlow(params, recorder, cdp, this.crawlState, workerid);
    });

    await page.exposeFunction(BxFunctionBindings.NextFlowStep, (id: string) => {
      return nextFlowStep(id, page, workerid);
    });

    if (this.params.failOnContentCheck) {
      await page.exposeFunction(
        BxFunctionBindings.ContentCheckFailed,
        (reason: string) => {
          // if called outside of awaitPageLoad(), ignore
          if (!opts.data.contentCheckAllowed) {
            return;
          }
          void this.crawlState.setFailReason(reason);
          logger.fatal(
            "Content check failed, failing crawl",
            { reason },
            "behavior",
            ExitCodes.Failed,
          );
        },
      );
    }
  }

  async setupExecContextEvents(
    cdp: CDPSession,
    frameIdToExecId: Map<string, number>,
  ) {
    await cdp.send("Runtime.enable");

    cdp.on(
      "Runtime.executionContextCreated",
      (params: Protocol.Runtime.ExecutionContextCreatedEvent) => {
        const { id, auxData } = params.context;
        if (auxData && auxData.isDefault && auxData.frameId) {
          frameIdToExecId.set(auxData.frameId, id);
        }
      },
    );

    cdp.on(
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

    cdp.on("Runtime.executionContextsCleared", () => {
      frameIdToExecId.clear();
    });
  }

  async loadCustomBehaviors(sources: string[]) {
    let str = "";

    for (const { contents } of await collectCustomBehaviors(
      this.downloadsDir,
      sources,
    )) {
      str += `self.__bx_behaviors.load(${contents});\n`;
    }

    return str;
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const sources = this.params.customBehaviors;

    if (!sources) {
      return;
    }

    for (const { path, contents } of await collectCustomBehaviors(
      this.downloadsDir,
      sources,
    )) {
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

    const { page, cdp, data, workerid, callbacks, recorder } = opts;
    data.callbacks = callbacks;

    const { url, seedId } = data;

    const auth = this.seeds[seedId].authHeader();

    if (auth) {
      logger.debug("Setting HTTP basic auth for seed", {
        seedId,
        seedUrl: this.seeds[seedId].url,
      });
    }

    const logDetails = { page: url, workerid };
    data.logDetails = logDetails;
    data.workerid = workerid;

    let result = false;

    if (recorder) {
      try {
        const headers = auth
          ? { Authorization: auth, ...this.headers }
          : this.headers;

        result = await timedRun(
          recorder.directFetchCapture({
            url,
            headers,
            cdp,
            state: data,
            crawler: this,
          }),
          this.params.pageLoadTimeout,
          "Direct fetch of page URL timed out",
          logDetails,
          "fetch",
        );
      } catch (e) {
        logger.error(
          "Direct fetch of page URL failed",
          { e, ...logDetails },
          "fetch",
        );
      }

      if (!result) {
        logger.debug(
          "Direct fetch response not accepted, continuing with browser fetch",
          logDetails,
          "fetch",
        );
      } else {
        return;
      }
    }

    opts.markPageUsed();
    opts.pageBlockUnload = false;

    if (auth) {
      await page.setExtraHTTPHeaders({ Authorization: auth });
      opts.isAuthSet = true;
    } else if (opts.isAuthSet) {
      await page.setExtraHTTPHeaders({});
    }

    const seed = await this.crawlState.getSeedAt(
      this.seeds,
      this.numOriginalSeeds,
      seedId,
    );

    if (recorder) {
      recorder.pageSeed = seed;
    }

    // run custom driver here, if any
    if (this.driver) {
      await this.driver({ page, data, crawler: this, seed });
    } else {
      await this.loadPage(page, data, seed);
    }

    data.title = await timedRun(
      page.title(),
      PAGE_OP_TIMEOUT_SECS,
      "Timed out getting page title, something is likely wrong",
      logDetails,
    );
    data.favicon = await this.getFavicon(page, logDetails);

    opts.pageBlockUnload = true;

    await this.doPostLoadActions(opts);

    opts.pageBlockUnload = false;

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
        logger.warn("Skipping behaviors for slow page", logDetails, "behavior");
      } else {
        // allow failing crawl via script from within behaviors also
        data.contentCheckAllowed = true;

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

        data.contentCheckAllowed = false;

        await this.netIdle(page, logDetails);

        if (res) {
          data.loadState = LoadState.BEHAVIORS_DONE;
        }

        if (textextract && this.params.text.includes("final-to-warc")) {
          await textextract.extractAndStoreText("textFinal", true, true);
        }

        if (
          this.params.screenshot &&
          this.screenshotWriter &&
          this.params.screenshot.includes("fullPageFinal")
        ) {
          await timedRun(
            page.evaluate(() => {
              window.scrollTo(0, 0);
            }),
            PAGE_OP_TIMEOUT_SECS,
            "Page scroll timed out",
            logDetails,
          );

          const screenshots = new Screenshots({
            browser: this.browser,
            page,
            url,
            writer: this.screenshotWriter,
          });
          await screenshots.takeFullPageFinal();
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

  async pageFinished(data: PageState, lastErrorText = "") {
    // not yet finished
    if (data.asyncLoading) {
      return;
    }
    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails, depth, url, pageSkipped, noRetries } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      await this.writePage(data);

      logger.info("Page Finished", { loadState, ...logDetails }, "pageStatus");

      await this.crawlState.markFinished(url);

      if (this.healthChecker) {
        this.healthChecker.resetErrors();
      }

      await this.serializeConfig();

      await this.checkLimits();
    } else {
      if (pageSkipped) {
        await this.crawlState.markExcluded(url);
      } else {
        const retry = await this.crawlState.markFailed(url, noRetries);

        if (this.healthChecker) {
          this.healthChecker.incError();
        }

        if (retry < 0) {
          await this.writePage(data);

          await this.serializeConfig();

          if (depth === 0 && this.params.failOnFailedSeed) {
            let errorCode = ExitCodes.GenericError;

            switch (lastErrorText) {
              case "net::ERR_SOCKS_CONNECTION_FAILED":
              case "net::SOCKS_CONNECTION_HOST_UNREACHABLE":
              case "net::ERR_PROXY_CONNECTION_FAILED":
              case "net::ERR_TUNNEL_CONNECTION_FAILED":
                errorCode = ExitCodes.ProxyError;
                break;

              case "net::ERR_TIMED_OUT":
              case "net::ERR_INVALID_AUTH_CREDENTIALS":
                if (this.proxyServer || this.proxyPacUrl) {
                  errorCode = ExitCodes.ProxyError;
                }
                break;
            }
            logger.fatal(
              "Seed Page Load Failed, failing crawl",
              {},
              "general",
              errorCode,
            );
          }
        }
      }

      await this.checkLimits();
    }
  }

  async teardownPage({ workerid }: WorkerState) {
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

      logger.debug(
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

      logger.debug(
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

  async updateCurrSize(): Promise<number> {
    if (this.params.dryRun) {
      return 0;
    }

    const size = await getDirSize(this.archivesDir);

    await this.crawlState.setArchiveSize(size);

    return size;
  }

  async checkLimits() {
    let interrupt: InterruptReason | null = null;

    const size = await this.updateCurrSize();

    if (this.params.sizeLimit) {
      if (size >= this.params.sizeLimit) {
        logger.info(
          `Size threshold reached ${size} >= ${this.params.sizeLimit}, stopping`,
        );
        interrupt = InterruptReason.SizeLimit;
      }
    }

    if (this.params.timeLimit) {
      const elapsed = secondsElapsed(this.startTime);
      if (elapsed >= this.params.timeLimit) {
        logger.info(
          `Time threshold reached ${elapsed} > ${this.params.timeLimit}, stopping`,
        );
        interrupt = InterruptReason.TimeLimit;
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
        interrupt = InterruptReason.DiskUtilization;
      }
    }

    if (this.params.failOnFailedLimit) {
      const numFailed = await this.crawlState.numFailed();
      const failedLimit = this.params.failOnFailedLimit;
      if (numFailed >= failedLimit) {
        logger.fatal(
          `Failed threshold reached ${numFailed} >= ${failedLimit}, failing crawl`,
          {},
          "general",
          ExitCodes.FailedLimit,
        );
      }
    }

    if (await this.crawlState.isCrawlPaused()) {
      interrupt = InterruptReason.CrawlPaused;
    }

    if (interrupt) {
      this.uploadAndDeleteLocal = true;
      this.gracefulFinishOnInterrupt(interrupt);
      return true;
    }

    return false;
  }

  gracefulFinishOnInterrupt(interruptReason: InterruptReason) {
    this.interruptReason = interruptReason;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (!this.params.waitOnDone && !this.params.restartsOnError) {
      this.finalExit = true;
    }
  }

  async checkCanceled() {
    if (this.crawlState && (await this.crawlState.isCrawlCanceled())) {
      await this.setStatusAndExit(ExitCodes.Success, "canceled");
    }
  }

  async setStatusAndExit(exitCode: ExitCodes, status: string) {
    logger.info(`Exiting, Crawl status: ${status}`);

    await this.closeLog();

    if (this.crawlState && status) {
      await this.crawlState.setStatus(status);
    }
    process.exit(exitCode);
  }

  async serializeAndExit() {
    await this.serializeConfig();

    if (this.interruptReason) {
      await closeWorkers(0);
      await this.browser.close();
      await this.closeFiles();

      if (!this.done) {
        await this.setStatusAndExit(
          ExitCodes.SignalInterruptedForce,
          "interrupted",
        );
        return;
      }
    }

    await this.setStatusAndExit(ExitCodes.Success, "done");
  }

  async isCrawlRunning() {
    if (this.interruptReason) {
      return false;
    }

    if (await this.crawlState.isCrawlCanceled()) {
      await this.setStatusAndExit(ExitCodes.Success, "canceled");
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
        this.browser,
        async () => {
          await this.updateCurrSize();
        },
      );
    }

    if (this.params.driver) {
      try {
        const driverUrl = new URL(this.params.driver, import.meta.url);
        this.driver = (await import(driverUrl.href)).default;
      } catch (e) {
        logger.warn(`Error importing driver ${this.params.driver}`, e);
        return;
      }
    }

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

    if (this.params.generateWACZ || this.params.saveProfile) {
      this.storage = initStorage();
    }

    if (this.params.generateWACZ && this.storage) {
      await this.crawlState.setWACZFilename();
    }

    if (POST_CRAWL_STATES.includes(initState)) {
      logger.info("crawl already finished, running post-crawl tasks", {
        state: initState,
      });
      this.finalExit = true;
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

    if (await this.checkLimits()) {
      // if interrupted
      await this.postCrawl();
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
        this.params.blockRules as BlockRuleDecl[],
        this.captureBasePrefix,
        this.params.blockMessage,
      );
    }

    this.screencaster = this.initScreenCaster();

    if (this.params.originOverride && this.params.originOverride.length) {
      this.originOverride = new OriginOverride(
        this.params.originOverride as string[],
      );
    }

    await this._addInitialSeeds();

    await this.browser.launch({
      profileUrl: this.params.profile,
      headless: this.params.headless,
      emulateDevice: this.emulateDevice,
      swOpt: this.params.serviceWorker,
      chromeOptions: {
        proxyServer: this.proxyServer,
        proxyPacUrl: this.proxyPacUrl,
        userAgent: this.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ondisconnect: (err: any) => {
        this.markBrowserCrashed();
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
    await runWorkers(
      this,
      this.params.workers,
      this.maxPageTime,
      false,
      !!this.params.saveProfile,
    );
    // --------------

    await this.browser.close();

    await this.serializeConfig(true);

    await this.closePages();

    await this.closeFiles();

    await this.writeStats();

    // if crawl has been stopped or finished, mark as final exit for post-crawl tasks
    if (
      (await this.crawlState.isCrawlStopped()) ||
      (await this.crawlState.isFinished())
    ) {
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
    this.postCrawling = true;
    logger.info("Crawling done");

    if (this.params.combineWARC && !this.params.dryRun) {
      await this.combineWARC();
    }

    const generateFiles =
      !this.params.dryRun &&
      (!this.interruptReason || this.finalExit || this.uploadAndDeleteLocal);

    if (
      (this.params.generateCDX || this.params.generateWACZ) &&
      generateFiles
    ) {
      logger.info("Merging CDX");
      await this.crawlState.setStatus(
        this.params.generateWACZ ? "generate-wacz" : "generate-cdx",
      );

      await mergeCDXJ(
        this.warcCdxDir,
        this.indexesDir,
        this.params.generateWACZ ? null : false,
      );
    }

    if (this.params.generateWACZ && generateFiles) {
      const uploaded = await this.generateWACZ();

      if (uploaded && this.uploadAndDeleteLocal) {
        await this.crawlState.setArchiveSize(0);
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

    if (this.finalExit && generateFiles && this.params.saveProfile) {
      const resource = await this.browser.saveProfile(
        this.params.saveProfile,
        this.storage,
        this.params.saveProfile,
      );
      if (resource && resource.path) {
        await this.crawlState.markProfileUploaded(resource);
      }
    }

    if (this.params.waitOnDone && (!this.interruptReason || this.finalExit)) {
      this.done = true;
      logger.info("All done, waiting for signal...");
      await this.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  markBrowserCrashed() {
    this.interruptReason = InterruptReason.BrowserCrashed;
    this.browser.crashed = true;
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
      // possibly restarted after committing, so assume done here!
      if ((await this.crawlState.numDone()) > 0) {
        return;
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
      warcCdxDir: this.warcCdxDir,
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

    try {
      const wacz = new WACZ(waczOpts, this.collDir);
      if (!streaming) {
        await wacz.generateToFile(waczPath);
      }

      if (this.storage) {
        await this.crawlState.setStatus("uploading-wacz");

        const targetFilename = await this.crawlState.getWACZFilename();

        await this.storage.uploadCollWACZ(wacz, targetFilename, isFinished);

        await this.crawlState.clearWACZFilename();

        return true;
      }

      return false;
    } catch (e) {
      logger.error("Error creating WACZ", e);
      if (!streaming) {
        logger.fatal("Unable to write WACZ successfully");
      } else if (this.params.restartsOnError) {
        await this.setStatusAndExit(ExitCodes.UploadFailed, "interrupted");
      }
    }
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

    const pendingPages = await this.crawlState.getPendingList();
    const pending = pendingPages.length;
    const crawled = await this.crawlState.numDone();
    const failed = await this.crawlState.numFailed();
    const total = await this.crawlState.numFound();
    const limit = { max: this.pageLimit || 0, hit: this.limitHit };
    const stats = {
      crawled,
      total,
      pending,
      failed,
      limit,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pageFailed(msg: string, retry: number, msgData: any) {
    if (retry < this.params.maxPageRetries) {
      logger.warn(
        msg + ": will retry",
        { retry, retries: this.params.maxPageRetries, ...msgData },
        "pageStatus",
      );
    } else {
      logger.error(
        msg + ": retry limit reached",
        { retry, retries: this.params.maxPageRetries, ...msgData },
        "pageStatus",
      );
    }
    throw new Error("logged");
  }

  async loadPage(page: Page, data: PageState, seed: ScopedSeed) {
    const { url, depth, retry } = data;

    const logDetails = data.logDetails;

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
      if (!isRedirectStatus(resp.status())) {
        firstResponse = resp;
        // don't listen to any additional responses
        page.off("response", waitFirstResponse);
      }
    };

    const handleFirstLoadEvents = () => {
      page.on("response", waitFirstResponse);

      // store that domcontentloaded was finished
      page.once("domcontentloaded", () => {
        data.loadState = LoadState.CONTENT_LOADED;
      });
    };

    const gotoOpts = data.isHTMLPage
      ? this.gotoOpts
      : { waitUntil: "domcontentloaded" };

    logger.info("Awaiting page load", logDetails);

    const urlNoHash = url.split("#")[0];

    const fullRefresh = urlNoHash === page.url().split("#")[0];

    try {
      if (!fullRefresh) {
        handleFirstLoadEvents();
      }
      // store the page load response when page fully loads
      fullLoadedResponse = await page.goto(url, gotoOpts);

      if (fullRefresh) {
        logger.debug("Hashtag-only change, doing full page reload");

        handleFirstLoadEvents();

        fullLoadedResponse = await page.reload(gotoOpts);
      }
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
        // log if not already log and rethrow, consider page failed
        if (msg !== "logged") {
          const loadState = data.loadState;

          if (msg.startsWith("net::ERR_BLOCKED_BY_RESPONSE")) {
            // excluded in recorder
            data.pageSkipped = true;
            logger.warn("Page Load Blocked, skipping", { msg, loadState });
            throw new Error("logged");
          } else {
            return this.pageFailed("Page Load Failed", retry, {
              msg,
              url,
              loadState,
              ...logDetails,
            });
          }
        }
      }
    }

    const resp = fullLoadedResponse || downloadResponse || firstResponse;

    if (!resp) {
      return this.pageFailed("Page Load Failed, no response", retry, {
        url,
        ...logDetails,
      });
    }

    const respUrl = resp.url().split("#")[0];
    const isChromeError = page.url().startsWith("chrome-error://");

    if (
      depth === 0 &&
      !isChromeError &&
      respUrl !== urlNoHash &&
      respUrl + "/" !== url &&
      !downloadResponse
    ) {
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
      const failText = resp.request().failure()?.errorText;
      if (isChromeError && failText === "net::ERR_HTTP_RESPONSE_CODE_FAILURE") {
        data.noRetries = true;
        logger.warn(
          "Page is an empty non-200 response, not retrying",
          { url, status, ...logDetails },
          "pageStatus",
        );
        throw new Error("logged");
      }

      return this.pageFailed(
        isChromeError ? "Page Crashed on Load" : "Page Invalid Status",
        retry,
        { url, status, ...logDetails },
      );
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
    const frames = page.frames();

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

    const { seedId, extraHops } = data;

    if (!seed) {
      logger.error(
        "Seed not found, likely invalid crawl state - skipping link extraction and behaviors",
        { seedId, ...logDetails },
      );
      return;
    }

    await this.checkCF(page, logDetails);

    await this.netIdle(page, logDetails);

    // allow failing crawl via script only within awaitPageLoad()
    data.contentCheckAllowed = true;

    await this.awaitPageLoad(page.mainFrame(), logDetails);

    data.contentCheckAllowed = false;

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(depth, extraHops)) {
      logger.debug("Skipping Link Extraction, At Max Depth", {}, "links");
      return;
    }

    logger.debug(
      "Extracting links",
      { selectors: this.params.selectLinks, ...logDetails },
      "links",
    );

    await this.extractLinks(page, data, this.params.selectLinks, logDetails);
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
        concurrency: this.params.netIdleMaxRequests,
      });
    } catch (e) {
      logger.debug("waitForNetworkIdle timed out, ignoring", details);
      // ignore, continue
    }
  }

  async awaitPageLoad(frame: Frame, logDetails: LogDetails) {
    if (this.params.behaviorOpts) {
      try {
        await timedRun(
          frame.evaluate(
            "self.__bx_behaviors && self.__bx_behaviors.awaitPageLoad();",
          ),
          PAGE_OP_TIMEOUT_SECS * 4,
          "Custom page load check timed out",
          logDetails,
        );
      } catch (e) {
        logger.warn("Waiting for custom page load failed", e, "behavior");
      }
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
    selectors: ExtractSelector[],
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

    const frames = filteredFrames || page.frames();

    try {
      for (const { selector, extract, attrOnly } of selectors) {
        await Promise.allSettled(
          frames.map((frame) => {
            const getLinks = frame
              .evaluate(
                `self.__bx_behaviors.extractLinks(${JSON.stringify(
                  selector,
                )}, ${JSON.stringify(extract)}, ${attrOnly})`,
              )
              .catch((e) =>
                logger.warn("Link Extraction failed in frame", {
                  frameUrl: frame.url,
                  ...logDetails,
                  ...formatErr(e),
                }),
              );

            return timedRun(
              getLinks,
              PAGE_OP_TIMEOUT_SECS,
              "Link extraction timed out",
              logDetails,
            );
          }),
        );
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

    if (
      this.params.robots &&
      (await isDisallowedByRobots(url, logDetails, this.params.robotsAgent))
    ) {
      logger.debug(
        "Page URL not queued, disallowed by robots.txt",
        { url, ...logDetails },
        "links",
      );
      return false;
    }

    const result = await this.crawlState.addToQueue(
      { url, seedId, depth, extraHops, ts, pageid },
      this.pageLimit,
    );

    switch (result) {
      case QueueState.ADDED:
        logger.debug("Queued new page URL", { url, ...logDetails }, "links");
        return true;

      case QueueState.LIMIT_HIT:
        logger.debug(
          "Page URL not queued, at page limit",
          { url, ...logDetails },
          "links",
        );
        if (!this.limitHit && depth === 0) {
          logger.error(
            "Page limit reached when adding URL list, some URLs not crawled.",
          );
        }
        this.limitHit = true;
        return false;

      case QueueState.DUPE_URL:
        logger.debug(
          "Page URL not queued, already seen",
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
        header.hasText = this.params.text.includes("to-pages") + "";
        if (this.params.text.length) {
          logger.debug("Text Extraction: " + this.params.text.join(","));
        } else {
          logger.debug("Text Extraction: None");
        }
        fh.write(JSON.stringify(header) + "\n");
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

    if (depth === 0) {
      row.seed = true;
    }

    if (Number.isInteger(depth)) {
      row.depth = depth;
    }

    if (favicon) {
      row.favIconUrl = favicon;
    }

    if (this.params.writePagesToRedis) {
      await this.crawlState.writeToPagesQueue(
        this.pageEntryForRedis(row, state),
      );
    }

    if (text && this.textInPages) {
      row.text = text;
    }

    const processedRow = JSON.stringify(row) + "\n";

    const pagesFH = depth > 0 ? this.extraPagesFH : this.pagesFH;

    if (!pagesFH) {
      logger.error("Can't write pages, missing stream", {}, "pageStatus");
      return;
    }

    try {
      pagesFH.write(processedRow);
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

    if (
      (this.params.scopeType === "page" ||
        this.params.scopeType === "page-spa") &&
      !this.params.extraHops
    ) {
      logger.info("Single page crawl, skipping sitemap", {}, "sitemap");
      return;
    }

    if (await this.crawlState.isSitemapDone()) {
      logger.info("Sitemap already processed, skipping", {}, "sitemap");
      return;
    }

    const fromDate = this.params.sitemapFromDate
      ? new Date(this.params.sitemapFromDate)
      : undefined;
    const toDate = this.params.sitemapToDate
      ? new Date(this.params.sitemapToDate)
      : undefined;
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

    let power = 1;
    let resolved = false;

    let finished = false;

    const p = new Promise<void>((resolve) => {
      sitemapper.on("end", () => {
        resolve();
        if (!finished) {
          logger.info(
            "Sitemap Parsing Finished",
            { urlsFound: sitemapper.count, limitHit: sitemapper.atLimit() },
            "sitemap",
          );
          this.crawlState
            .markSitemapDone()
            .catch((e) => logger.warn("Error marking sitemap done", e));
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
          const pending = sitemapper.getNumPending();
          logger.debug(
            "Sitemap URLs processed so far",
            { count, sitemapsQueued, pending },
            "sitemap",
          );
        }
        this.queueInScopeUrls(seedId, [url], 0, 0, true).catch((e) =>
          logger.warn("Error queuing urls", e, "links"),
        );
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

    let found = false;
    try {
      found = await sitemapper.parse(sitemap, url);
    } catch (e) {
      //
    }

    if (found) {
      await p;
    } else {
      logger.warn("No sitemap for seed", { url, sitemap }, "sitemap");
    }
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
      fh.end();
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

    const crawlDir = path.join(this.collDir, "crawls");

    await fsp.mkdir(crawlDir, { recursive: true });

    const filenameOnly = `${interpolateFilename("@ts-@id", this.crawlId)}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.crawlState.serialize();

    if (this.origConfig) {
      this.origConfig.state = state;
    }

    try {
      const res = yaml.dump(this.origConfig, { lineWidth: -1 });
      logger.info(`Saving crawl state to: ${filename}`);
      await fsp.writeFile(filename, res);
    } catch (e) {
      logger.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    if (!this.saveStateFiles.includes(filename)) {
      this.saveStateFiles.push(filename);
    }

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
      await this.storage.uploadFile(filename, filenameOnly);
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
    const useSHA1 = this.params.useSHA1;

    return new WARCWriter({
      archivesDir: this.archivesDir,
      warcCdxDir: this.warcCdxDir,
      filenameTemplate,
      rolloverSize: this.params.rolloverSize,
      gzip,
      useSHA1,
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
    // ignore
  }

  return null;
}
