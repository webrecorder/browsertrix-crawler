import * as child_process from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "request";

import { Logger } from "./logger.js";
import { initStorage } from "./storage.js";

import { chromium } from "playwright-core";

const logger = new Logger();

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));


// ==================================================================
export class Browser
{
  constructor() {}

  async launch({dataDir, chromeOptions, headless = false, emulateDevice = {viewport: null}} = {}) {
    const args = this.chromeArgs(chromeOptions);
    const userDataDir = dataDir || profileDir;

    const launchOpts = {
      ...emulateDevice,
      args,
      headless,
      executablePath: this.getBrowserExe(),
      ignoreHTTPSErrors: true,
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      serviceWorkers: dataDir ? "block" : "allow",
    };

    return await chromium.launchPersistentContext(userDataDir, launchOpts);
  }

  async loadProfile(profileFilename) {
    const targetFilename = "/tmp/profile.tar.gz";

    if (profileFilename &&
        (profileFilename.startsWith("http:") || profileFilename.startsWith("https:"))) {

      logger.info(`Downloading ${profileFilename} to ${targetFilename}`, {}, "browserProfile");

      const p = new Promise((resolve, reject) => {
        request.get(profileFilename).
          on("error", (err) => reject(err)).
          pipe(fs.createWriteStream(targetFilename)).
          on("finish", () => resolve());
      });

      await p;
        
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
      "--ignore-certificate-errors",
      "--no-sandbox",
      "--disable-background-media-suspend",
      "--remote-debugging-port=9221",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-site-isolation-trials",
      `--user-agent=${userAgent || this.getDefaultUA()}`,
      ...extraArgs,
    ];

    if (proxy) {
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

  async evaluateWithCLI(frame, funcString, logData, contextName) {
    let details = {frameUrl: frame.url(), ...logData};

    logger.info("Run Script Started", details, contextName);

    const { exceptionDetails, result}  = await frame.evaluate(funcString);

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

