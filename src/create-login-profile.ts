#!/usr/bin/env node

import fs from "fs";
import path from "path";
import http, { IncomingMessage, ServerResponse } from "http";

import readline from "readline";
import child_process from "child_process";

import yargs, { Options } from "yargs";

import { logger } from "./util/logger.js";

import { Browser } from "./util/browser.js";
import { initStorage } from "./util/storage.js";
import { CDPSession, Page, PuppeteerLifeCycleEvent } from "puppeteer-core";
import { getInfoString } from "./util/file_reader.js";

const profileHTML = fs.readFileSync(
  new URL("../html/createProfile.html", import.meta.url),
  { encoding: "utf8" },
);
const vncHTML = fs.readFileSync(
  new URL("../html/vnc_lite.html", import.meta.url),
  { encoding: "utf8" },
);

const behaviors = fs.readFileSync(
  new URL(
    "../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url,
  ),
  { encoding: "utf8" },
);

function cliOpts(): { [key: string]: Options } {
  return {
    url: {
      describe: "The URL of the login page",
      type: "string",
      demandOption: true,
    },

    user: {
      describe:
        "The username for the login. If not specified, will be prompted",
    },

    password: {
      describe:
        "The password for the login. If not specified, will be prompted (recommended)",
    },

    filename: {
      describe:
        "The filename for the profile tarball, stored within /crawls/profiles if absolute path not provided",
      default: "/crawls/profiles/profile.tar.gz",
    },

    debugScreenshot: {
      describe:
        "If specified, take a screenshot after login and save as this filename",
    },

    headless: {
      describe: "Run in headless mode, otherwise start xvfb",
      type: "boolean",
      default: false,
    },

    automated: {
      describe: "Start in automated mode, no interactive browser",
      type: "boolean",
      default: false,
    },

    interactive: {
      describe: "Deprecated. Now the default option!",
      type: "boolean",
      default: false,
    },

    shutdownWait: {
      describe:
        "Shutdown browser in interactive after this many seconds, if no pings received",
      type: "number",
      default: 0,
    },

    profile: {
      describe:
        "Path to tar.gz file which will be extracted and used as the browser profile",
      type: "string",
    },

    windowSize: {
      type: "string",
      describe: "Browser window dimensions, specified as: width,height",
      default: getDefaultWindowSize(),
    },

    proxy: {
      type: "boolean",
      default: false,
    },

    cookieDays: {
      type: "number",
      describe:
        "If >0, set all cookies, including session cookies, to have this duration in days before saving profile",
      default: 7,
    },
  };
}

function getDefaultWindowSize() {
  const values = (process.env.GEOMETRY || "").split("x");
  const x = Number(values[0]);
  const y = Number(values[1]);
  return `${x},${y}`;
}

function handleTerminate(signame: string) {
  logger.info(`Got signal ${signame}, exiting`);
  process.exit(1);
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = yargs(process.argv)
    .usage("browsertrix-crawler profile [options]")
    .option(cliOpts()).argv;

  logger.setDebugLogging(true);

  logger.info(await getInfoString());

  process.on("SIGINT", () => handleTerminate("SIGINT"));

  process.on("SIGTERM", () => handleTerminate("SIGTERM"));

  if (!params.headless) {
    logger.debug("Launching XVFB");
    child_process.spawn("Xvfb", [
      process.env.DISPLAY || "",
      "-listen",
      "tcp",
      "-screen",
      "0",
      process.env.GEOMETRY || "",
      "-ac",
      "+extension",
      "RANDR",
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
      process.env.VNC_PASS || "",
      "-display",
      process.env.DISPLAY || "",
    ]);
  }

  const browser = new Browser();

  await browser.launch({
    profileUrl: params.profile,
    headless: params.headless,
    signals: false,
    chromeOptions: {
      proxy: false,
      extraArgs: [
        "--window-position=0,0",
        `--window-size=${params.windowSize}`,
        // to disable the 'stability will suffer' infobar
        "--test-type",
      ],
    },
    recording: false,
  });

  if (params.interactive) {
    logger.warn(
      "Note: the '--interactive' flag is now deprecated and is the default profile creation option. Use the --automated flag to specify non-interactive mode",
    );
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

  const { page, cdp } = await browser.newWindowPageWithCDP();

  const waitUntil: PuppeteerLifeCycleEvent = "load";

  await page.setCacheEnabled(false);

  if (!params.automated) {
    await browser.setupPage({ page, cdp });

    // for testing, inject browsertrix-behaviors
    await browser.addInitScript(
      page,
      behaviors + ";\nself.__bx_behaviors.init();",
    );
  }

  if (!params.automated) {
    const target = await cdp.send("Target.getTargetInfo");
    const targetId = target.targetInfo.targetId;

    const ibrowser = new InteractiveBrowser(
      params,
      browser,
      page,
      cdp,
      targetId,
    );
    await ibrowser.startLoad(waitUntil);
  } else {
    await automatedProfile(params, browser, page, cdp, waitUntil);
  }
}

async function automatedProfile(
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  browser: Browser,
  page: Page,
  cdp: CDPSession,
  waitUntil: PuppeteerLifeCycleEvent,
) {
  let u, p;

  logger.info(`Loading page: ${params.url}`);

  try {
    await page.goto(params.url, { waitUntil });
  } catch (e) {
    logger.error("Page Load Failed/Interrupted", e);
  }

  logger.debug("Looking for username and password entry fields on page...");

  try {
    u = await page.waitForSelector(
      "//input[contains(@name, 'user') or contains(@name, 'email')]",
    );
    p = await page.waitForSelector(
      "//input[contains(@name, 'pass') and @type='password']",
    );
  } catch (e) {
    if (params.debugScreenshot) {
      await page.screenshot({ path: params.debugScreenshot });
    }
    logger.debug("Login form could not be found");
    await page.close();
    process.exit(1);
    return;
  }

  await u!.type(params.user);

  await p!.type(params.password);

  await Promise.allSettled([
    p!.press("Enter"),
    page.waitForNavigation({ waitUntil }),
  ]);

  if (params.debugScreenshot) {
    await page.screenshot({ path: params.debugScreenshot });
  }

  await createProfile(params, browser, page, cdp);

  process.exit(0);
}

async function createProfile(
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  browser: Browser,
  page: Page,
  cdp: CDPSession,
  targetFilename = "",
) {
  await cdp.send("Network.clearBrowserCache");

  await browser.close();

  logger.info("Creating profile");

  if (params.filename && !params.filename.startsWith("/")) {
    params.filename = path.resolve("/crawls/profiles/", params.filename);
    logger.info(
      `Absolute path for filename not provided, saving to ${params.filename}`,
    );
  }

  const profileFilename = params.filename || "/crawls/profiles/profile.tar.gz";

  const outputDir = path.dirname(profileFilename);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  browser.saveProfile(profileFilename);

  let resource = {};

  const storage = initStorage();
  if (storage) {
    logger.info("Uploading to remote storage...");
    resource = await storage.uploadFile(profileFilename, targetFilename);
  }

  logger.info("Profile creation done");
  return resource;
}

function promptInput(msg: string, hidden = false) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rl: any = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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

  return new Promise<string>((resolve) => {
    rl.question(msg, function (res: string) {
      rl.close();
      resolve(res);
    });
  });
}

class InteractiveBrowser {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  browser: Browser;
  page: Page;
  cdp: CDPSession;

  targetId: string;
  originSet = new Set<string>();

  shutdownWait: number;
  shutdownTimer: NodeJS.Timer | null;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    browser: Browser,
    page: Page,
    cdp: CDPSession,
    targetId: string,
  ) {
    logger.info("Creating Profile Interactively...");
    child_process.spawn("socat", [
      "tcp-listen:9222,reuseaddr,fork",
      "tcp:localhost:9221",
    ]);

    this.params = params;
    this.browser = browser;
    this.page = page;
    this.cdp = cdp;

    this.targetId = targetId;

    this.addOrigin();

    page.on("load", () => this.handlePageLoad());

    // attempt to keep everything to initial tab if headless
    if (this.params.headless) {
      cdp.send("Page.enable");

      cdp.on("Page.windowOpen", async (resp) => {
        if (!resp.url) {
          return;
        }

        try {
          await cdp.send("Target.activateTarget", { targetId: this.targetId });
          await page.goto(resp.url);
        } catch (e) {
          logger.error("Page Load Failed/Interrupted", e);
        }
      });
    }

    this.shutdownWait = params.shutdownWait * 1000;

    if (this.shutdownWait) {
      this.shutdownTimer = setTimeout(() => process.exit(0), this.shutdownWait);
      logger.debug(
        `Shutting down in ${this.shutdownWait}ms if no ping received`,
      );
    } else {
      this.shutdownTimer = null;
    }

    const httpServer = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    const port = 9223;
    httpServer.listen(port);
    logger.info(
      `Browser Profile UI Server started. Load http://localhost:${port}/ to interact with a Chromium-based browser, click 'Create Profile' when done.`,
    );

    if (!params.headless) {
      logger.info("Screencasting with VNC on port 6080");
    } else {
      logger.info("Screencasting with CDP on port 9222");
    }
  }

  async startLoad(waitUntil: PuppeteerLifeCycleEvent = "load") {
    logger.info(`Loading page: ${this.params.url}`);

    try {
      await this.page.goto(this.params.url, { waitUntil, timeout: 0 });
      logger.info("Loaded!");
    } catch (e) {
      logger.warn("Page Load Failed/Interrupted", e);
    }
  }

  handlePageLoad() {
    this.addOrigin();
    this.saveCookiesFor(this.page.url());
  }

  async saveAllCookies() {
    logger.info("Saving all cookies");

    for (const origin of this.originSet.values()) {
      await this.saveCookiesFor(origin + "/");
    }
  }

  async saveCookiesFor(url: string) {
    try {
      if (this.params.cookieDays <= 0) {
        return;
      }

      const cookies = await this.browser.getCookies(this.page);
      for (const cookieOrig of cookies) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cookie = cookieOrig as any;
        cookie.expires =
          new Date().getTime() / 1000 + this.params.cookieDays * 86400;

        delete cookie.size;
        delete cookie.session;
        if (
          cookie.sameSite &&
          cookie.sameSite !== "Lax" &&
          cookie.sameSite !== "Strict"
        ) {
          delete cookie.sameSite;
        }
        if (!cookie.domain && !cookie.path) {
          cookie.url = url;
        }
      }
      await this.browser.setCookies(this.page, cookies);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      logger.error("Save Cookie Error: ", e);
    }
  }

  addOrigin() {
    const url = this.page.url();
    logger.debug("Adding origin", { url });
    if (url.startsWith("http:") || url.startsWith("https:")) {
      this.originSet.add(new URL(url).origin);
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = new URL(req.url || "", `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    let targetUrl;
    let origins;

    switch (pathname) {
      case "/":
        res.writeHead(200, { "Content-Type": "text/html" });
        if (this.params.headless) {
          targetUrl = `http://$HOST:9222/devtools/inspector.html?ws=$HOST:9222/devtools/page/${this.targetId}&panel=resources`;
        } else {
          targetUrl = `http://$HOST:9223/vnc/?host=$HOST&port=6080&password=${process.env.VNC_PASS}`;
        }
        res.end(
          profileHTML.replace(
            "$DEVTOOLS_SRC",
            targetUrl.replaceAll("$HOST", parsedUrl.hostname),
          ),
        );
        return;

      case "/vnc/":
      case "/vnc/index.html":
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(vncHTML);
        return;

      case "/ping":
        if (this.shutdownWait) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          clearTimeout(this.shutdownTimer as any);
          this.shutdownTimer = setTimeout(
            () => process.exit(0),
            this.shutdownWait,
          );
          logger.debug(
            `Ping received, delaying shutdown for ${this.shutdownWait}ms`,
          );
        }

        origins = Array.from(this.originSet.values());

        res.writeHead(200, { "Content-Type": "application/json" });

        res.end(JSON.stringify({ pong: true, origins }));
        return;

      case "/target":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ targetId: this.targetId }));
        return;

      case "/vncpass":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ password: process.env.VNC_PASS }));
        return;

      case "/navigate":
        if (req.method !== "POST") {
          break;
        }

        try {
          const postData = await this.readBodyJson(req);
          const url = new URL(postData.url).href;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));

          logger.info("Loading Page", { page: url });

          this.page
            .goto(url)
            .catch((e) => logger.warn("Page Load Failed/Interrupted", e));

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.toString() }));
          logger.warn("HTTP Error", e);
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

          const resource = await createProfile(
            this.params,
            this.browser,
            this.page,
            this.cdp,
            targetFilename,
          );
          origins = Array.from(this.originSet.values());

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ resource, origins }));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.toString() }));
          logger.warn("HTTP Error", e);
        }

        setTimeout(() => process.exit(0), 200);
        return;

      case "/createProfile":
        if (req.method !== "POST") {
          break;
        }

        try {
          await this.saveAllCookies();

          await createProfile(this.params, this.browser, this.page, this.cdp);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body>Profile Created! You may now close this window.</body></html>",
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(
            "<html><body>Profile creation failed! See the browsertrix-crawler console for more info",
          );
          logger.warn("HTTP Error", e);
        }

        setTimeout(() => process.exit(0), 200);
        return;
    }

    if (pathname.startsWith("/vnc/")) {
      const fileUrl = new URL(
        "../node_modules/@novnc/novnc/" + pathname.slice("/vnc/".length),
        import.meta.url,
      );
      const file = fs.readFileSync(fileUrl, { encoding: "utf-8" });
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(file);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("Not Found");
  }

  async readBodyJson(req: IncomingMessage) {
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
