import * as child_process from "child_process";
import fs from "fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import os from "os";
import path from "path";

import { logger } from "./logger.js";
import { initStorage } from "./storage.js";

import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";


// ==================================================================
export class Browser
{
  constructor() {
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
    this.customProfile = false;
  }

  async launch({profileUrl, chromeOptions, signals = false, headless = false, emulateDevice = {viewport: null}} = {}) {
    if (this.isLaunched()) {
      return;
    }

    if (profileUrl) {
      this.customProfile = await this.loadProfile(profileUrl);
    }

    const args = this.chromeArgs(chromeOptions);

    const launchOpts = {
      ...emulateDevice,
      args,
      headless,
      executablePath: this.getBrowserExe(),
      ignoreDefaultArgs: ["--enable-automation"],
      ignoreHTTPSErrors: true,
      handleSIGHUP: signals,
      handleSIGINT: signals,
      handleSIGTERM: signals,
      serviceWorkers: "allow"
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

  async getFirstPageWithCDP() {
    return {page: this.firstPage, cdp: this.firstCDP};
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

  async evaluateWithCLI_(context, frame, funcString, logData, contextName) {
    let details = {frameUrl: frame.url(), ...logData};

    logger.info("Run Script Started", details, contextName);

    const cdp = await context.newCDPSession(frame);

    // from puppeteer _evaluateInternal() but with includeCommandLineAPI: true
    //const contextId = context._contextId;
    const expression = funcString + "\n//# sourceURL=__playwright_evaluation_script__";

    const { exceptionDetails, result } = await cdp
      .send("Runtime.evaluate", {
        expression,
        //contextId,
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

    try {
      await cdp.detach();
    } catch (e) {
      logger.warn("Detach failed", details, contextName);
    }

    return result.value;
  }
}

// ==================================================================
export class PlaywrightBrowser extends Browser
{
  addInitScript(page, script) {
    return page.addInitScript(script);
  }

  async responseHeader(resp, header) {
    return await resp.headerValue(header);
  }

  async evaluateWithCLI(page, frame, funcString, logData, contextName) {
    const context = page.context();
    return await this.evaluateWithCLI_(context, frame, funcString, logData, contextName);
  }
}


// ==================================================================
export class NewContextBrowser extends PlaywrightBrowser
{
  constructor() {
    super();
    this.browser = null;
    this.contexts = new Map();

    this.launchOpts = null;
  }

  isLaunched() {
    if (this.browser) {
      logger.warn("Browser already inited", {}, "browser");
      return true;
    }

    return false;
  }

  async close() {
    for (const context of this.contexts.values()) {
      await context.close();
    }
    this.contexts.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async closePage(page) {
    try {
      await page.close();
    } catch (e) {
      // ignore
    }

    const context = this.contexts.get(page);
    if (context) {
      await context.close();
      this.contexts.delete(page);
    }
  }

  async _init(launchOpts) {
    if (this.customProfile) {
      throw new Error("not supported yet");
    }
    
    this.browser = await chromium.launch(launchOpts);
    this.launchOpts = launchOpts;
  }

  numPages() {
    return this.contexts.length;
  }

  async newWindowPageWithCDP(storageState) {
    const context = await this.browser.newContext({...this.launchOpts, storageState});

    const page = await context.newPage();

    const cdp = await context.newCDPSession(page);

    this.contexts.set(page, context);

    return {page, cdp};
  }
}


// ==================================================================
export class PersistentContextBrowser extends PlaywrightBrowser
{
  constructor() {
    super();
    this.context = null;

    this.firstPage = null;
    this.firstCDP = null;
  }

  isLaunched() {
    if (this.context) {
      logger.warn("Context already inited", {}, "context");
      return true;
    }

    return false;
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }

  async closePage(page) {
    await page.close();
  }

  async _init(launchOpts) {
    this.context = await chromium.launchPersistentContext(this.profileDir, launchOpts);

    if (this.context.pages().length) {
      this.firstPage = this.context.pages()[0];
    } else {
      this.firstPage = await this.context.newPage();
    }
    this.firstCDP = await this.context.newCDPSession(this.firstPage);
  }


  numPages() {
    return this.context ? this.context.pages().length : 0;
  }

  async newWindowPageWithCDP() {
    // unique url to detect new pages
    const startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);

    const p = new Promise((resolve) => {
      const listener = (page) => {
        if (page.url() === startPage) {
          resolve(page);
          this.context.removeListener("page", listener);
        }
      };

      this.context.on("page", listener);
    });

    await this.firstCDP.send("Target.createTarget", {url: startPage, newWindow: true});

    const page = await p;

    const cdp = await this.context.newCDPSession(page);

    return {page, cdp};
  }
}


// ==================================================================
export class PuppeteerPersistentContextBrowser extends Browser
{
  constructor() {
    super();
    this.browser = null;

    this.firstPage = null;
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

  async closePage(page) {
    await page.close();
  }

  async _init(launchOpts) {
    launchOpts = {...launchOpts,
      defaultViewport: null,
      waitForInitialPage: false,
      userDataDir: this.profileDir
    };

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

    await this.firstCDP.send("Target.createTarget", {url: startPage, newWindow: true});

    const target = await p;

    const page = await target.page();

    const cdp = await target.createCDPSession();

    return {page, cdp};
  }

  async responseHeader(resp, header) {
    return await resp.headers()[header];
  }

  async evaluateWithCLI(_, frame, funcString, logData, contextName) {
    const context = await frame.executionContext();
    return await this.evaluateWithCLI_(context, frame, funcString, logData, contextName);
  }
}
