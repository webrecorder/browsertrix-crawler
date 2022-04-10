#!/usr/bin/env node

const readline = require("readline");
const child_process = require("child_process");

const puppeteer = require("puppeteer-core");
const yargs = require("yargs");

const { getBrowserExe, loadProfile, saveProfile, chromeArgs, sleep } = require("./util/browser");
const { initStorage } = require("./util/storage");

const fs = require("fs");
const path = require("path");
const http = require("http");
const profileHTML = fs.readFileSync(path.join(__dirname, "html", "createProfile.html"), {encoding: "utf8"});

const behaviors = fs.readFileSync(path.join(__dirname, "node_modules", "browsertrix-behaviors", "dist", "behaviors.js"), {encoding: "utf8"});

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
      default: "/output/profile.tar.gz",
    },

    "debugScreenshot": {
      describe: "If specified, take a screenshot after login and save as this filename"
    },

    "headless": {
      describe: "Run in headless mode, otherwise start xvfb",
      type: "boolean",
      default: false,
    },

    "interactive": {
      describe: "Start in interactive mode!",
      type: "boolean",
      default: false,
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
      default: "1600,900"
    },

    "proxy": {
      type: "boolean",
      default: false
    }
  };
}



async function main() {
  const params = yargs
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
  }

  let useProxy = false;

  if (params.proxy) {
    child_process.spawn("wayback", ["--live", "--proxy", "live"], {stdio: "inherit", cwd: "/tmp"});

    console.log("Running with pywb proxy");

    await sleep(3000);

    useProxy = true;
  }

  const browserArgs = chromeArgs(useProxy, null, [
    "--remote-debugging-port=9221",
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
  };

  if (!params.user && !params.interactive) {
    params.user = await promptInput("Enter username: ");
  }

  if (!params.password && !params.interactive) {
    params.password = await promptInput("Enter password: ", true);
  }

  const browser = await puppeteer.launch(args);

  const page = await browser.newPage();

  const waitUntil =  ["load", "networkidle2"];

  await page.setCacheEnabled(false);

  if (params.interactive) {
    await page.evaluateOnNewDocument("Object.defineProperty(navigator, \"webdriver\", {value: false});");
    // for testing, inject browsertrix-behaviors
    await page.evaluateOnNewDocument(behaviors + ";\nself.__bx_behaviors.init();");
  }

  console.log("loading");

  await page.goto(params.url, {waitUntil});
  
  console.log("loaded");

  if (params.interactive) {
    new InteractiveBrowser(params, browser, page);
    return;
  }


  let u, p;

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

async function createProfile(params, browser, page) {
  await page._client.send("Network.clearBrowserCache");

  await browser.close();

  console.log("creating profile");

  const profileFilename = params.filename || "/output/profile.tar.gz";

  saveProfile(profileFilename);

  let resource = {};

  const storage = initStorage("profiles/");
  if (storage) {
    console.log("Uploading to remote storage...");
    resource = await storage.uploadFile(profileFilename);
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

    page.on("load", () => this.addOrigin());

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

    switch (pathname) {
    case "/":
      targetUrl = `http://$HOST:9222/devtools/inspector.html?ws=$HOST:9222/devtools/page/${this.targetId}&panel=resources`;
      res.writeHead(200, {"Content-Type": "text/html"});
      res.end(profileHTML.replace("$DEVTOOLS_SRC", targetUrl.replaceAll("$HOST", parsedUrl.hostname)));
      return;

    case "/ping":
      if (this.shutdownWait) {
        clearInterval(this.shutdownTimer);
        this.shutdownTimer = setTimeout(() => process.exit(0), this.shutdownWait);
        console.log(`Ping received, delaying shutdown for ${this.shutdownWait}ms`);
      }
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({"pong": true}));
      return;

    case "/target":
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({targetId: this.targetId}));
      return;

    case "/createProfileJS":
      if (req.method !== "POST") {
        break;
      }

      try {
        const resource = await createProfile(this.params, this.browser, this.page);
        const origins = Array.from(this.originSet.values());

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

    res.writeHead(404, {"Content-Type": "text/html"});
    res.end("Not Found");
  }
}


main();

