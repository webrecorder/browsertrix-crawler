import * as child_process from "child_process";
import fs from "fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import os from "os";
import path from "path";

import { logger } from "./logger.js";
import { initStorage } from "./storage.js";

import puppeteer from "puppeteer-core";


// ==================================================================
export class BaseBrowser
{
  constructor() {
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    this.customProfile = false;
    this.emulateDevice = null;
  }

  async launch({profileUrl, chromeOptions, signals = false, headless = false, emulateDevice = {}} = {}) {
    if (this.isLaunched()) {
      return;
    }

    if (profileUrl) {
      this.customProfile = await this.loadProfile(profileUrl);
    }

    this.emulateDevice = emulateDevice;

    const args = this.chromeArgs(chromeOptions);

    const launchOpts = {
      args,
      headless,
      executablePath: this.getBrowserExe(),
      ignoreDefaultArgs: ["--enable-automation"],
      ignoreHTTPSErrors: true,
      handleSIGHUP: signals,
      handleSIGINT: signals,
      handleSIGTERM: signals,

      defaultViewport: null,
      waitForInitialPage: false,
      userDataDir: this.profileDir
    };

    await this._init(launchOpts);
  }

  async setupPage({page, cdp}) {
    await this.addInitScript(page, "Object.defineProperty(navigator, \"webdriver\", {value: false});");

    if (this.customProfile) {
      logger.info("Disabling Service Workers for profile", {}, "browser");

      await cdp.send("Network.setBypassServiceWorker", {bypass: true});
    }
  }

  async loadProfile(profileFilename) {
    const targetFilename = "/tmp/profile.tar.gz";

    if (profileFilename &&
        (profileFilename.startsWith("http:") || profileFilename.startsWith("https:"))) {

      logger.info(`Downloading ${profileFilename} to ${targetFilename}`, {}, "browserProfile");

      const resp = await fetch(profileFilename);
      await pipeline(
        Readable.fromWeb(resp.body),
        fs.createWriteStream(targetFilename)
      );

      profileFilename = targetFilename;
    } else if (profileFilename && profileFilename.startsWith("@")) {
      const storage = initStorage("");

      if (!storage) {
        logger.fatal("Profile specified relative to s3 storage, but no S3 storage defined");
      }

      await storage.downloadFile(profileFilename.slice(1), targetFilename);

      profileFilename = targetFilename;
    }

    if (profileFilename) {
      try {
        child_process.execSync("tar xvfz " + profileFilename, {cwd: this.profileDir});
        return true;
      } catch (e) {
        logger.error(`Profile filename ${profileFilename} not a valid tar.gz`);
      }
    }

    return false;
  }

  saveProfile(profileFilename) {
    child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: this.profileDir});
  }

  chromeArgs({proxy=true, userAgent=null, extraArgs=[]} = {}) {
    // Chrome Flags, including proxy server
    const args = [
      ...defaultArgs,
      ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean),
      //"--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
      "--no-sandbox",
      "--disable-background-media-suspend",
      "--remote-debugging-port=9221",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-site-isolation-trials",
      `--user-agent=${userAgent || this.getDefaultUA()}`,
      ...extraArgs,
    ];

    if (proxy) {
      args.push("--ignore-certificate-errors");
      args.push(`--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
    }

    return args;
  }

  getDefaultUA() {
    let version = process.env.BROWSER_VERSION;

    try {
      version = child_process.execFileSync(this.getBrowserExe(), ["--version"], {encoding: "utf8"});
      version = version.match(/[\d.]+/)[0];
    } catch(e) {
      console.error(e);
    }

    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  getBrowserExe() {
    const files = [process.env.BROWSER_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
    for (const file of files) {
      if (file && fs.existsSync(file)) {
        return file;
      }
    }

    return null;
  }

  async evaluateWithCLI_(cdp, frame, cdpContextId, funcString, logData, contextName) {
    let details = {frameUrl: frame.url(), ...logData};

    logger.info("Run Script Started", details, contextName);

    // from puppeteer _evaluateInternal() but with includeCommandLineAPI: true
    //const contextId = context._contextId;
    const expression = funcString + "\n//# sourceURL=__evaluation_script__";

    const { exceptionDetails, result } = await cdp
      .send("Runtime.evaluate", {
        expression,
        contextId: cdpContextId,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        includeCommandLineAPI: true,
      });

    if (exceptionDetails) {
      if (exceptionDetails.stackTrace) {
        details = {...exceptionDetails.stackTrace, text: exceptionDetails.text, ...details};
      }
      logger.error("Run Script Failed", details, contextName);
    } else {
      logger.info("Run Script Finished", details, contextName);
    }

    return result.value;
  }
}


// ==================================================================
export class Browser extends BaseBrowser
{
  constructor() {
    super();
    this.browser = null;

    this.firstCDP = null;
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
      await this.browser.close();
      this.browser = null;
    }
  }

  addInitScript(page, script) {
    return page.evaluateOnNewDocument(script);
  }

  async _init(launchOpts) {
    this.browser = await puppeteer.launch(launchOpts);

    const target = this.browser.target();

    this.firstCDP = await target.createCDPSession();
  }

  numPages() {
    return this.browser ? this.browser.pages().length : 0;
  }

  async newWindowPageWithCDP() {
    // unique url to detect new pages
    const startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);

    const p = new Promise((resolve) => {
      const listener = (target) => {
        if (target.url() === startPage) {
          resolve(target);
          this.browser.removeListener("targetcreated", listener);
        }
      };

      this.browser.on("targetcreated", listener);
    });

    try {
      await this.firstCDP.send("Target.createTarget", {url: startPage, newWindow: true});
    } catch (e) {
      const target = this.browser.target();

      this.firstCDP = await target.createCDPSession();

      await this.firstCDP.send("Target.createTarget", {url: startPage, newWindow: true});
    }

    const target = await p;

    const page = await target.page();

    const device = this.emulateDevice;

    if (device) {
      if (device.viewport && device.userAgent) {
        await page.emulate(device);
      } else if (device.userAgent) {
        await page.setUserAgent(device.userAgent);
      }
    }

    const cdp = await target.createCDPSession();

    return {page, cdp};
  }

  async responseHeader(resp, header) {
    return await resp.headers()[header];
  }

  async evaluateWithCLI(_, frame, cdp, funcString, logData, contextName) {
    const context = await frame.executionContext();
    cdp = context._client;
    const cdpContextId = context._contextId;
    return await this.evaluateWithCLI_(cdp, frame, cdpContextId, funcString, logData, contextName);
  }

  interceptRequest(page, callback) {
    page.on("request", callback);
  }

  async waitForNetworkIdle(page, params) {
    return await page.waitForNetworkIdle(params);
  }

  async setViewport(page, params) {
    await page.setViewport(params);
  }

  async getCookies(page) {
    return await page.cookies();
  }

  async setCookies(page, cookies) {
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
  "--export-tagged-pdf"
];
