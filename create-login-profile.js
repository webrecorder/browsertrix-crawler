#!/usr/bin/env node

import fs from "fs";
import path from "path";
import http from "http";

import readline from "readline";
import child_process from "child_process";

import puppeteer from "puppeteer-core";
import yargs from "yargs";

import { getBrowserExe, loadProfile, saveProfile, chromeArgs, sleep } from "./util/browser.js";
import { initStorage } from "./util/storage.js";

const profileHTML = fs.readFileSync(new URL("html/createProfile.html", import.meta.url), {encoding: "utf8"});
const vncHTML = fs.readFileSync(new URL("html/vnc_lite.html", import.meta.url), {encoding: "utf8"});

const behaviors = fs.readFileSync(new URL("./node_modules/browsertrix-behaviors/dist/behaviors.js", import.meta.url), {encoding: "utf8"});

function cliOpts() {
  return {
    "url": {
      describe: "The URL of the login page",
      type: "string",
      demandOption: true,
    },

    "user": {
      describe: "The username for the login. If not specified, will be prompted",
    },

    "password": {
      describe: "The password for the login. If not specified, will be prompted (recommended)",
    },

    "filename": {
      describe: "The filename for the profile tarball",
      default: "/crawls/profiles/profile.tar.gz",
    },

    "debugScreenshot": {
      describe: "If specified, take a screenshot after login and save as this filename"
    },

    "headless": {
      describe: "Run in headless mode, otherwise start xvfb",
      type: "boolean",
      default: false,
    },

    "automated": {
      describe: "Start in automated mode, no interactive browser",
      type: "boolean",
      default: false,
    },

    "interactive": {
      describe: "Deprecated. Now the default option!"
      type: "boolean",
      default: false
    },

    "shutdownWait": {
      describe: "Shutdown browser in interactive after this many seconds, if no pings received",
      type: "number",
      default: 0
    },

    "profile": {
      describe: "Path to tar.gz file which will be extracted and used as the browser profile",
      type: "string",
    },

    "windowSize": {
      type: "string",
      describe: "Browser window dimensions, specified as: width,height",
      default: getDefaultWindowSize()
    },

    "proxy": {
      type: "boolean",
      default: false
    },

    "cookieDays": {
      type: "number",
      describe: "If >0, set all cookies, including session cookies, to have this duration in days before saving profile",
      default: 7
    }
  };
}

function getDefaultWindowSize() {
  const values = process.env.GEOMETRY.split("x");
  const x = Number(values[0]);
  const y = Number(values[1]);
  return `${x},${y}`;
}



async function main() {
  const params = yargs(process.argv)
    .usage("browsertrix-crawler profile [options]")
    .option(cliOpts())
    .argv;

  if (!params.headless) {
    console.log("Launching XVFB");
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

    //await fsp.mkdir(path.join(homedir(), ".vnc"), {recursive: true});

    //child_process.spawnSync("x11vnc", ["-storepasswd", process.env.VNC_PASS, path.join(homedir(), ".vnc", "passwd")]);

    child_process.spawn("x11vnc", [
      "-forever",
      "-ncache_cr",
      "-xdamage",
      "-usepw",
      "-shared",
      "-rfbport",
      "6080",
      "-passwd",
      process.env.VNC_PASS,
      "-display",
      process.env.DISPLAY
    ]);
  }

  let useProxy = false;

  if (params.proxy) {
    child_process.spawn("wayback", ["--live", "--proxy", "live"], {stdio: "inherit", cwd: "/tmp"});

    console.log("Running with pywb proxy");

    await sleep(3000);

    useProxy = true;
  }

  const browserArgs = chromeArgs(useProxy, null, [
    "--window-position=0,0",
    `--window-size=${params.windowSize}`,
  ]);

  //await new Promise(resolve => setTimeout(resolve, 2000));
  const profileDir = await loadProfile(params.profile);

  const args = {
    headless: !!params.headless,
    executablePath: getBrowserExe(),
    ignoreHTTPSErrors: true,
    args: browserArgs,
    userDataDir: profileDir,
    defaultViewport: null,
    waitForInitialPage: false
  };

  if (params.interactive) {
    console.log("Note: the '--interactive' flag is now deprecated and is the default profile creation option. Use the --automated flag to specify non-interactive mode");
  }

  if (params.user || params.password) {
    params.automated = true;
  }

  if (!params.user && params.automated) {
    params.user = await promptInput("Enter username: ");
  }

  if (!params.password && params.automated) {
    params.password = await promptInput("Enter password: ", true);
  }

  const browser = await puppeteer.launch(args);

  const page = await browser.newPage();

  const waitUntil =  ["load", "networkidle2"];

  await page.setCacheEnabled(false);

  if (!params.automated) {
    await page.evaluateOnNewDocument("Object.defineProperty(navigator, \"webdriver\", {value: false});");
    // for testing, inject browsertrix-behaviors
    await page.evaluateOnNewDocument(behaviors + ";\nself.__bx_behaviors.init();");
  }

  console.log(`Loading page: ${params.url}`);

  await page.goto(params.url, {waitUntil});

  if (!params.automated) {
    new InteractiveBrowser(params, browser, page);
  } else {
    await automatedProfile(params, browser, page, waitUntil);
  }
}

async function automatedProfile(params, browser, page, waitUntil) {
  let u, p;

  console.log("Looking for username and password entry fields on page...");

  try {
    u = await page.waitForXPath("//input[contains(@name, 'user') or contains(@name, 'email')]");
    p = await page.waitForXPath("//input[contains(@name, 'pass') and @type='password']");

  } catch (e) {
    if (params.debugScreenshot) {
      await page.screenshot({path: params.debugScreenshot});
    }
    console.log("Login form could not be found");
    await page.close();
    process.exit(1);
    return;
  }

  await u.type(params.user);

  await p.type(params.password);

  await Promise.allSettled([
    p.press("Enter"),
    page.waitForNavigation({waitUntil})
  ]);

  if (params.debugScreenshot) {
    await page.screenshot({path: params.debugScreenshot});
  }

  await createProfile(params, browser, page);

  process.exit(0);
}

async function createProfile(params, browser, page, targetFilename = "") {
  await page._client().send("Network.clearBrowserCache");

  await browser.close();

  console.log("creating profile");

  const profileFilename = params.filename || "/crawls/profiles/profile.tar.gz";
 
  const outputDir = path.dirname(profileFilename);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, {recursive: true});
  }

  saveProfile(profileFilename);

  let resource = {};

  const storage = initStorage();
  if (storage) {
    console.log("Uploading to remote storage...");
    resource = await storage.uploadFile(profileFilename, targetFilename);
  }

  console.log("done");
  return resource;
}

function promptInput(msg, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  if (hidden) {
    // from https://stackoverflow.com/a/59727173
    rl.input.on("keypress", function () {
      // get the number of characters entered so far:
      const len = rl.line.length;
      // move cursor back to the beginning of the input:
      readline.moveCursor(rl.output, -len, 0);
      // clear everything to the right of the cursor:
      readline.clearLine(rl.output, 1);
      // replace the original input with asterisks:
      for (let i = 0; i < len; i++) {
        rl.output.write("*");
      }
    });
  }

  return new Promise((resolve) => {
    rl.question(msg, function (res) {
      rl.close();
      resolve(res);
    });
  });
}


class InteractiveBrowser {
  constructor(params, browser, page) {
    console.log("Creating Profile Interactively...");
    child_process.spawn("socat", ["tcp-listen:9222,fork", "tcp:localhost:9221"]);

    this.params = params;
    this.browser = browser;
    this.page = page;

    const target = page.target();
    this.targetId = target._targetId;

    this.originSet = new Set();

    this.addOrigin();

    page.on("load", () => this.handlePageLoad());

    page.on("popup", async () => {
      await this.page._client().send("Target.activateTarget", {targetId: this.targetId});
    });

    page._client().on("Page.windowOpen", async (resp) => {
      if (resp.url) {
        await page.goto(resp.url);
      }
    });

    this.shutdownWait = params.shutdownWait * 1000;
    
    if (this.shutdownWait) {
      this.shutdownTimer = setTimeout(() => process.exit(0), this.shutdownWait);
      console.log(`Shutting down in ${this.shutdownWait}ms if no ping received`);
    } else {
      this.shutdownTimer = 0;
    }

    const httpServer = http.createServer((req, res) => this.handleRequest(req, res));
    const port = 9223;
    httpServer.listen(port);
    console.log(`Browser Profile UI Server started. Load http://localhost:${port}/ to interact with a Chromium-based browser, click 'Create Profile' when done.`);

    if (!params.headless) {
      console.log("Screencasting with VNC on port 6080");
    } else {
      console.log("Screencasting with CDP on port 9222");
    }
  }

  handlePageLoad() {
    this.addOrigin();
    this.saveCookiesFor(this.page.url());
  }

  async saveAllCookies() {
    console.log("Saving all cookies");

    for (const origin of this.originSet.values()) {
      await this.saveCookiesFor(origin + "/");
    }
  }

  async saveCookiesFor(url) {
    try {
      if (this.params.cookieDays <= 0) {
        return;
      }

      const cookies = await this.page.cookies(url);
      for (const cookie of cookies) {
        cookie.url = url;
        cookie.expires = (new Date().getTime() / 1000) + this.params.cookieDays * 86400;
        delete cookie.size;
        delete cookie.session;
        if (cookie.sameSite && cookie.sameSite !== "Lax" && cookie.sameSite !== "Strict") {
          delete cookie.sameSite;
        }
      }
      await this.page.setCookie(...cookies);
    } catch (e) {
      console.log("Save Cookie Error: " + e);
    }
  }

  addOrigin() {
    const url = this.page.url();
    console.log("Adding origin for", url);
    if (url.startsWith("http:") || url.startsWith("https:")) {
      this.originSet.add(new URL(url).origin);
    }
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    let targetUrl;
    let origins;

    switch (pathname) {
    case "/":
      res.writeHead(200, {"Content-Type": "text/html"});
      if (this.params.headless) {
        targetUrl = `http://$HOST:9222/devtools/inspector.html?ws=$HOST:9222/devtools/page/${this.targetId}&panel=resources`;
      } else {
        targetUrl = `http://$HOST:9223/vnc/?host=$HOST&port=6080&password=${process.env.VNC_PASS}`;
      }
      res.end(profileHTML.replace("$DEVTOOLS_SRC", targetUrl.replaceAll("$HOST", parsedUrl.hostname)));
      return;

    case "/vnc/":
    case "/vnc/index.html":
      res.writeHead(200, {"Content-Type": "text/html"});
      res.end(vncHTML);
      return;

    case "/ping":
      if (this.shutdownWait) {
        clearInterval(this.shutdownTimer);
        this.shutdownTimer = setTimeout(() => process.exit(0), this.shutdownWait);
        console.log(`Ping received, delaying shutdown for ${this.shutdownWait}ms`);
      }

      origins = Array.from(this.originSet.values());

      res.writeHead(200, {"Content-Type": "application/json"});

      res.end(JSON.stringify({pong: true, origins}));
      return;

    case "/target":
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({targetId: this.targetId}));
      return;

    case "/vncpass":
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({password: process.env.VNC_PASS}));
      return;

    case "/navigate":
      if (req.method !== "POST") {
        break;
      }

      try {
        const postData = await this.readBodyJson(req);
        const url = new URL(postData.url).href;

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({success: true}));

        this.page.goto(url);

      } catch (e) {
        res.writeHead(400, {"Content-Type": "application/json"});
        res.end(JSON.stringify({"error": e.toString()}));
        console.log(e);
      }
      return;

    case "/createProfileJS":
      if (req.method !== "POST") {
        break;
      }

      try {
        const postData = await this.readBodyJson(req);
        const targetFilename = postData.filename || "";

        await this.saveAllCookies();

        const resource = await createProfile(this.params, this.browser, this.page, targetFilename);
        origins = Array.from(this.originSet.values());

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({resource, origins}));
      } catch (e) {
        res.writeHead(500, {"Content-Type": "application/json"});
        res.end(JSON.stringify({"error": e.toString()}));
        console.log(e);
      }

      setTimeout(() => process.exit(0), 200);
      return;

    case "/createProfile":
      if (req.method !== "POST") {
        break;
      }

      try {
        await this.saveAllCookies();

        await createProfile(this.params, this.browser, this.page);

        res.writeHead(200, {"Content-Type": "text/html"});
        res.end("<html><body>Profile Created! You may now close this window.</body></html>");
      } catch (e) {
        res.writeHead(500, {"Content-Type": "text/html"});
        res.end("<html><body>Profile creation failed! See the browsertrix-crawler console for more info");
        console.log(e);
      }

      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (pathname.startsWith("/vnc/")) {
      const fileUrl = new URL("node_modules/@novnc/novnc/" + pathname.slice("/vnc/".length), import.meta.url);
      const file = fs.readFileSync(fileUrl, {encoding: "utf-8"});
      res.writeHead(200, {"Content-Type": "application/javascript"});
      res.end(file);
      return;
    }

    res.writeHead(404, {"Content-Type": "text/html"});
    res.end("Not Found");
  }

  async readBodyJson(req) {
    const buffers = [];

    for await (const chunk of req) {
      buffers.push(chunk);
    }

    const data = Buffer.concat(buffers).toString();

    if (data.length) {
      try {
        return JSON.parse(data) || {};
      } catch (e) {
        return {};
      }
    }
  }
}


main();

