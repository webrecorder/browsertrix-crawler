import * as child_process from "child_process";
import fs from "fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import os from "os";
import path from "path";

import { Logger } from "./logger.js";
import { initStorage } from "./storage.js";

import { chromium } from "playwright-core";

const logger = new Logger();

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));


// ==================================================================
export class Browser
{
  constructor() {
    this.context = null;

    this.firstPage = null;
    this.firstCDP = null;
  }

  async launch({dataDir, chromeOptions, signals = false, headless = false, emulateDevice = {viewport: null}} = {}) {
    if (this.context) {
      logger.warn("Context already inited", {}, "context");
      return this.context;
    }

    const args = this.chromeArgs(chromeOptions);
    const userDataDir = dataDir || profileDir;

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
      serviceWorkers: dataDir ? "block" : "allow",
    };

    this.context = await chromium.launchPersistentContext(userDataDir, launchOpts);

    if (this.context.pages()) {
      this.firstPage = this.context.pages()[0];
    } else {
      this.firstPage = await this.context.newPage();
    }
    this.firstCDP = await this.context.newCDPSession(this.firstPage);

    return this.context;
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }

  async getFirstPageWithCDP() {
    return {page: this.firstPage, cdp: this.firstCDP};
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
        child_process.execSync("tar xvfz " + profileFilename, {cwd: profileDir});
      } catch (e) {
        logger.error(`Profile filename ${profileFilename} not a valid tar.gz`);
      }
    }

    return profileDir;
  }

  saveProfile(profileFilename) {
    child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: profileDir});
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

  async evaluateWithCLI(context, frame, funcString, logData, contextName) {
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

