import * as child_process from "child_process";
import fs from "fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import os from "os";
import path from "path";

import { LogContext, logger } from "./logger.js";
import { initStorage } from "./storage.js";

import type { ServiceWorkerOpt } from "./constants.js";

import puppeteer, {
  Frame,
  HTTPRequest,
  Page,
  PuppeteerLaunchOptions,
  Viewport,
} from "puppeteer-core";
import { CDPSession, Target, Browser as PptrBrowser } from "puppeteer-core";
import { Recorder } from "./recorder.js";

type BtrixChromeOpts = {
  proxy?: string;
  userAgent?: string | null;
  extraArgs?: string[];
};

type LaunchOpts = {
  profileUrl: string;
  chromeOptions: BtrixChromeOpts;
  signals: boolean;
  headless: boolean;
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emulateDevice?: Record<string, any>;
  ondisconnect?: ((err: unknown) => NonNullable<unknown>) | null;

  swOpt?: ServiceWorkerOpt;

  recording: boolean;
};

// ==================================================================
export class Browser {
  profileDir: string;
  customProfile = false;
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emulateDevice: Record<string, any> | null = null;

  browser?: PptrBrowser | null = null;
  firstCDP: CDPSession | null = null;

  recorders: Recorder[] = [];

  swOpt?: ServiceWorkerOpt = "disabled";

  constructor() {
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
  }

  async launch({
    profileUrl,
    chromeOptions,
    signals = false,
    headless = false,
    emulateDevice = {},
    swOpt = "disabled",
    ondisconnect = null,
    recording = true,
  }: LaunchOpts) {
    if (this.isLaunched()) {
      return;
    }

    if (profileUrl) {
      this.customProfile = await this.loadProfile(profileUrl);
    }

    this.swOpt = swOpt;

    this.emulateDevice = emulateDevice;

    const args = this.chromeArgs(chromeOptions);

    if (recording) {
      args.push("--disable-site-isolation-trials");
    }

    let defaultViewport = null;

    if (process.env.GEOMETRY) {
      const geom = process.env.GEOMETRY.split("x");

      defaultViewport = { width: Number(geom[0]), height: Number(geom[1]) };
    }

    const launchOpts: PuppeteerLaunchOptions = {
      args,
      headless,
      executablePath: this.getBrowserExe(),
      ignoreDefaultArgs: ["--enable-automation", "--hide-scrollbars"],
      ignoreHTTPSErrors: true,
      handleSIGHUP: signals,
      handleSIGINT: signals,
      handleSIGTERM: signals,
      protocolTimeout: 0,

      defaultViewport,
      waitForInitialPage: false,
      userDataDir: this.profileDir,
      targetFilter: recording
        ? undefined
        : (target) => this.targetFilter(target),
    };

    await this._init(launchOpts, ondisconnect, recording);
  }

  targetFilter(target: Target) {
    const attach = !(!target.url() && target.type() === "other");
    logger.debug(
      "Target Filter",
      { url: target.url(), type: target.type(), attach },
      "browser",
    );
    return attach;
  }

  async setupPage({ page }: { page: Page; cdp: CDPSession }) {
    await this.addInitScript(
      page,
      'Object.defineProperty(navigator, "webdriver", {value: false});',
    );

    switch (this.swOpt) {
      case "disabled":
        logger.debug("Service Workers: always disabled", {}, "browser");
        await page.setBypassServiceWorker(true);
        break;

      case "disabled-if-profile":
        if (this.customProfile) {
          logger.debug(
            "Service Workers: disabled since using profile",
            {},
            "browser",
          );
          await page.setBypassServiceWorker(true);
        }
        break;

      case "enabled":
        logger.debug("Service Workers: always enabled", {}, "browser");
        break;
    }
  }

  async loadProfile(profileFilename: string): Promise<boolean> {
    const targetFilename = "/tmp/profile.tar.gz";

    if (
      profileFilename &&
      (profileFilename.startsWith("http:") ||
        profileFilename.startsWith("https:"))
    ) {
      logger.info(
        `Downloading ${profileFilename} to ${targetFilename}`,
        {},
        "browser",
      );

      const resp = await fetch(profileFilename);
      await pipeline(
        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Readable.fromWeb(resp.body as any),
        fs.createWriteStream(targetFilename),
      );

      profileFilename = targetFilename;
    } else if (profileFilename && profileFilename.startsWith("@")) {
      const storage = initStorage();

      if (!storage) {
        logger.fatal(
          "Profile specified relative to s3 storage, but no S3 storage defined",
        );
        return false;
      }

      await storage.downloadFile(profileFilename.slice(1), targetFilename);

      profileFilename = targetFilename;
    }

    if (profileFilename) {
      try {
        child_process.execSync("tar xvfz " + profileFilename, {
          cwd: this.profileDir,
        });
        return true;
      } catch (e) {
        logger.error(`Profile filename ${profileFilename} not a valid tar.gz`);
      }
    }

    return false;
  }

  saveProfile(profileFilename: string) {
    child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {
      cwd: this.profileDir,
    });
  }

  chromeArgs({
    proxy = "",
    userAgent = null,
    extraArgs = [],
  }: BtrixChromeOpts) {
    // Chrome Flags, including proxy server
    const args = [
      // eslint-disable-next-line no-use-before-define
      ...defaultArgs,
      ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean),
      //"--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
      "--no-sandbox",
      "--disable-background-media-suspend",
      "--remote-debugging-port=9221",
      "--remote-allow-origins=*",
      "--autoplay-policy=no-user-gesture-required",
      `--user-agent=${userAgent || this.getDefaultUA()}`,
      ...extraArgs,
    ];

    proxy = proxy || this.getProxy();

    if (proxy) {
      args.push("--ignore-certificate-errors");
      args.push(`--proxy-server=${proxy}`);
    }

    return args;
  }

  getDefaultUA() {
    let version: string | undefined = process.env.BROWSER_VERSION;

    try {
      const browser = this.getBrowserExe();
      if (browser) {
        version = child_process.execFileSync(browser, ["--version"], {
          encoding: "utf8",
        });
        const match = version && version.match(/[\d.]+/);
        if (match) {
          version = match[0];
        }
      }
    } catch (e) {
      console.error(e);
    }

    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  getProxy() {
    if (process.env.PROXY_SERVER) {
      return process.env.PROXY_SERVER;
    }

    // for backwards compatibility with 0.x proxy settings
    if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
      return `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
    }

    return "";
  }

  getBrowserExe() {
    const files = [
      process.env.BROWSER_BIN,
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
    ];
    for (const file of files) {
      if (file && fs.existsSync(file)) {
        return file;
      }
    }
  }

  async evaluateWithCLI(
    cdp: CDPSession,
    frame: Frame,
    frameIdToExecId: Map<string, number>,
    funcString: string,
    logData: Record<string, string>,
    contextName: LogContext,
  ) {
    const frameUrl = frame.url();
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let details: Record<string, any> = { frameUrl, ...logData };

    if (!frameUrl || frame.detached) {
      logger.info(
        "Run Script Skipped, frame no longer attached or has no URL",
        details,
        contextName,
      );
      return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frameId = (frame as any)._id;

    const contextId = frameIdToExecId.get(frameId);

    if (!contextId) {
      logger.warn(
        "Not running behavior, missing CDP context id for frame id",
        { frameId },
        "browser",
      );
      return;
    }

    logger.info("Run Script Started", details, contextName);

    // from puppeteer _evaluateInternal() but with includeCommandLineAPI: true
    //const contextId = context._contextId;
    const expression = funcString + "\n//# sourceURL=__evaluation_script__";

    const { exceptionDetails, result } = await cdp.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });

    if (exceptionDetails) {
      if (exceptionDetails.stackTrace) {
        details = {
          ...exceptionDetails.stackTrace,
          text: exceptionDetails.text,
          ...details,
        };
      }
      logger.error("Run Script Failed", details, contextName);
    } else {
      logger.info("Run Script Finished", details, contextName);
    }

    return result.value;
  }

  isLaunched() {
    if (this.browser) {
      logger.warn("Context already inited", {}, "browser");
      return true;
    }

    return false;
  }

  async close() {
    if (this.browser) {
      this.browser.removeAllListeners("disconnected");
      await this.browser.close();
      this.browser = null;
    }
  }

  addInitScript(page: Page, script: string) {
    return page.evaluateOnNewDocument(script);
  }

  async checkScript(cdp: CDPSession, filename: string, script: string) {
    const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: script,
    });
    if (exceptionDetails) {
      logger.fatal(
        "Custom behavior load error, aborting",
        { filename, ...exceptionDetails },
        "behavior",
      );
    }
  }

  async _init(
    launchOpts: PuppeteerLaunchOptions,
    // eslint-disable-next-line @typescript-eslint/ban-types
    ondisconnect: Function | null = null,
    recording: boolean,
  ) {
    this.browser = await puppeteer.launch(launchOpts);

    const target = this.browser.target();

    this.firstCDP = await target.createCDPSession();

    if (recording) {
      await this.serviceWorkerFetch();
    }

    if (ondisconnect) {
      this.browser.on("disconnected", (err) => ondisconnect(err));
    }
    this.browser.on("disconnected", () => {
      this.browser = null;
    });
  }

  async newWindowPageWithCDP(): Promise<{ cdp: CDPSession; page: Page }> {
    // unique url to detect new pages
    const startPage =
      "about:blank?_browsertrix" + Math.random().toString(36).slice(2);

    const p = new Promise<Target>((resolve) => {
      const listener = (target: Target) => {
        if (target.url() === startPage) {
          resolve(target);
          if (this.browser) {
            this.browser.off("targetcreated", listener);
          }
        }
      };

      if (this.browser) {
        this.browser.on("targetcreated", listener);
      }
    });

    if (!this.firstCDP) {
      throw new Error("CDP missing");
    }

    try {
      await this.firstCDP.send("Target.createTarget", {
        url: startPage,
        newWindow: true,
      });
    } catch (e) {
      if (!this.browser) {
        throw e;
      }
      const target = this.browser.target();

      this.firstCDP = await target.createCDPSession();

      await this.firstCDP.send("Target.createTarget", {
        url: startPage,
        newWindow: true,
      });
    }

    const target = await p;

    const page = await target.page();
    if (!page) {
      throw new Error("page missing");
    }

    const device = this.emulateDevice;

    if (device && page) {
      if (device.viewport && device.userAgent) {
        // TODO: Fix this the next time the file is edited.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.emulate(device as any);
      } else if (device.userAgent) {
        await page.setUserAgent(device.userAgent);
      }
    }

    const cdp = await target.createCDPSession();

    return { page, cdp };
  }

  async serviceWorkerFetch() {
    if (!this.firstCDP) {
      return;
    }

    this.firstCDP.on("Fetch.requestPaused", async (params) => {
      const { frameId, requestId, networkId, request } = params;

      if (!this.firstCDP) {
        throw new Error("CDP missing");
      }

      if (networkId) {
        try {
          await this.firstCDP.send("Fetch.continueResponse", { requestId });
        } catch (e) {
          logger.warn(
            "continueResponse failed",
            { url: request.url },
            "recorder",
          );
        }
        return;
      }

      let foundRecorder = null;

      for (const recorder of this.recorders) {
        if (recorder.swUrls.has(request.url)) {
          recorder.swFrameIds.add(frameId);
        }

        if (recorder.hasFrame(frameId)) {
          foundRecorder = recorder;
          break;
        }
      }

      if (!foundRecorder) {
        logger.warn(
          "Skipping URL from unknown frame",
          { url: request.url, frameId },
          "recorder",
        );

        try {
          await this.firstCDP.send("Fetch.continueResponse", { requestId });
        } catch (e) {
          logger.warn(
            "continueResponse failed",
            { url: request.url },
            "recorder",
          );
        }

        return;
      }

      await foundRecorder.handleRequestPaused(params, this.firstCDP, true);
    });

    await this.firstCDP.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });
  }

  interceptRequest(page: Page, callback: (event: HTTPRequest) => void) {
    page.on("request", callback);
  }

  async waitForNetworkIdle(page: Page, params: { timeout?: number }) {
    return await page.waitForNetworkIdle(params);
  }

  async setViewport(page: Page, params: Viewport) {
    await page.setViewport(params);
  }

  async getCookies(page: Page) {
    return await page.cookies();
  }

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setCookies(page: Page, cookies: any) {
    return await page.setCookie(...cookies);
  }
}

// ==================================================================
// Default Chromium args from playwright
export const defaultArgs = [
  "--disable-field-trial-config", // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/README.md
  "--disable-background-networking",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache", // Avoids surprises like main request not being intercepted during page.goBack().
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update", // Avoids unneeded network activity after startup.
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  // AvoidUnnecessaryBeforeUnloadCheckSync - https://github.com/microsoft/playwright/issues/14047
  // Translate - https://github.com/microsoft/playwright/issues/16126
  // Optimization* - https://bugs.chromium.org/p/chromium/issues/detail?id=1311753
  "--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--enable-automation",
  "--password-store=basic",
  "--use-mock-keychain",
  // See https://chromium-review.googlesource.com/c/chromium/src/+/2436773
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--apps-keep-chrome-alive-in-tests",
];
