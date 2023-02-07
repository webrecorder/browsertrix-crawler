import * as child_process from "child_process";
import fs from "fs";
import { chromium } from "playwright-core";


// ==================================================================
export class Browser
{
  constructor() {}

  async launch(opts = {}) {

    const args = this.chromeArgs(opts.chromeOptions);
    // const userDataDir = opts.dataDir || "/tmp/profile";

    const launchOpts = {
      args: args,
      headless: false,
      executablePath: this.getBrowserExe(),
      ignoreHTTPSErrors: true
    };

    // TODO: Playwright migration - should we use launchPersistentContext?
    // return await chromium.launchPersistentContext(userDataDir, launchOpts);
    return await chromium.launch(launchOpts);
  }

  // TODO: Playwright migration - load/save profiles
  async loadProfile() {
    return;
  }

  async saveProfile() {
    return;
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

  async evaluateWithCLI(frame, funcString) {
    const { exceptionDetails, result: remoteObject}  = await frame.evaluate(funcString);

    if (exceptionDetails) {
      throw new Error(
        "Behavior Evaluation Failed" + exceptionDetails.text
      );
    }

    return remoteObject.value;
  }
}

