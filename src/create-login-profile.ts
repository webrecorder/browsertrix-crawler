#!/usr/bin/env node

import fs from "fs";
import os from "os";
import http, { IncomingMessage, ServerResponse } from "http";

import readline from "readline";
import child_process from "child_process";

import yargs from "yargs";

import { logger } from "./util/logger.js";

import { Browser } from "./util/browser.js";
import { initStorage } from "./util/storage.js";
import { CDPSession, Page, PuppeteerLifeCycleEvent } from "puppeteer-core";
import { getInfoString } from "./util/file_reader.js";
import { DISPLAY, ExitCodes } from "./util/constants.js";
import { initProxy, loadProxyConfig } from "./util/proxy.js";
//import { sleep } from "./util/timing.js";

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

function initArgs() {
  return yargs(process.argv)
    .usage("browsertrix-crawler profile [options]")
    .options({
      url: {
        describe: "The URL of the login page",
        type: "string",
        demandOption: true,
      },

      user: {
        describe:
          "The username for the login. If not specified, will be prompted",
        type: "string",
      },

      password: {
        describe:
          "The password for the login. If not specified, will be prompted (recommended)",
        type: "string",
      },

      filename: {
        describe:
          "The filename for the profile tarball, stored within /crawls/profiles if absolute path not provided",
        type: "string",
        default: "/crawls/profiles/profile.tar.gz",
      },

      debugScreenshot: {
        describe:
          "If specified, take a screenshot after login and save as this filename",
        type: "boolean",
        default: false,
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
          "Path or HTTP(S) URL to tar.gz file which contains the browser profile directory",
        type: "string",
        default: "",
      },

      windowSize: {
        describe: "Browser window dimensions, specified as: width,height",
        type: "string",
        default: getDefaultWindowSize(),
      },

      cookieDays: {
        describe:
          "If >0, set all cookies, including session cookies, to have this duration in days before saving profile",
        type: "number",
        default: 7,
      },

      proxyServer: {
        describe:
          "if set, will use specified proxy server. Takes precedence over any env var proxy settings",
        type: "string",
      },

      proxyServerConfig: {
        describe:
          "if set, path to yaml/json file that configures multiple path servers per URL regex",
        type: "string",
      },

      sshProxyPrivateKeyFile: {
        describe:
          "path to SSH private key for SOCKS5 over SSH proxy connection",
        type: "string",
      },

      sshProxyKnownHostsFile: {
        describe:
          "path to SSH known hosts file for SOCKS5 over SSH proxy connection",
        type: "string",
      },
    })
    .parseSync();
}

function getDefaultWindowSize() {
  const values = (process.env.GEOMETRY || "").split("x");
  const x = Number(values[0]);
  const y = Number(values[1]);
  return `${x},${y}`;
}

function handleTerminate(signame: string) {
  logger.info(`Got signal ${signame}, exiting`);
  process.exit(ExitCodes.SignalInterrupted);
}

async function main() {
  const params = initArgs();

  logger.setDebugLogging(true);

  logger.info(await getInfoString());

  process.on("SIGINT", () => handleTerminate("SIGINT"));

  process.on("SIGTERM", () => handleTerminate("SIGTERM"));

  loadProxyConfig(params);

  const { proxyServer, proxyPacUrl } = await initProxy(params, false);

  if (!params.headless) {
    logger.debug("Launching XVFB");
    child_process.spawn("Xvfb", [
      DISPLAY,
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
      DISPLAY,
    ]);
  }

  const browser = new Browser(os.tmpdir());

  await browser.launch({
    profileUrl: params.profile,
    headless: params.headless,
    signals: false,
    chromeOptions: {
      proxyServer,
      proxyPacUrl,
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
      "input[name='user'],input[name='username'],input[name='email']",
    );
    p = await page.waitForSelector(
      "input[type='password'].input[name='pass'],input[name='password']",
    );
  } catch (e) {
    if (params.debugScreenshot) {
      await page.screenshot({ path: params.debugScreenshot });
    }
    logger.debug("Login form could not be found");
    await page.close();
    process.exit(ExitCodes.GenericError);
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

  await createProfile(browser, cdp, params.filename);

  process.exit(ExitCodes.Success);
}

async function createProfile(
  browser: Browser,
  cdp: CDPSession,
  localFilename: string,
  remoteFilename = "",
) {
  try {
    await cdp.send("Network.clearBrowserCache");
  } catch (e) {
    logger.warn("Error clearing cache", e, "browser");
  }

  await browser.close();

  const storage = initStorage();

  return await browser.saveProfile(localFilename, storage, remoteFilename);
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

    if (params.headless) {
      child_process.spawn("socat", [
        "tcp-listen:9222,reuseaddr,fork",
        "tcp:localhost:9221",
      ]);
    }

    this.params = params;
    this.browser = browser;
    this.page = page;
    this.cdp = cdp;

    this.targetId = targetId;

    this.addOrigin();

    page.on("load", () => this.handlePageLoad());

    // attempt to keep everything to initial tab if headless
    if (this.params.headless) {
      void cdp.send("Target.setDiscoverTargets", { discover: true });

      cdp.on("Target.targetCreated", async (params) => {
        const { targetInfo } = params;
        const { type, openerFrameId } = targetInfo;

        if (type === "page" && openerFrameId) {
          await cdp.send("Target.closeTarget", {
            targetId: params.targetInfo.targetId,
          });
        }

        await cdp.send("Runtime.runIfWaitingForDebugger");
      });

      void cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });

      cdp.send("Page.enable").catch((e) => logger.warn("Page.enable error", e));

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
      this.shutdownTimer = setTimeout(
        () => process.exit(ExitCodes.Success),
        this.shutdownWait,
      );
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
    this.saveCookiesFor(this.page.url()).catch((e) =>
      logger.warn("Error saving cookies", e),
    );
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

      const cookies = await this.browser.getCookies();

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
      await this.browser.setCookies(cookies);
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
            () => process.exit(ExitCodes.Success),
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
          const remoteFilename = postData.filename || "";

          await this.saveAllCookies();

          const resource = await createProfile(
            this.browser,
            this.cdp,
            this.params.filename,
            remoteFilename,
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

        setTimeout(() => process.exit(ExitCodes.Success), 200);
        return;

      case "/createProfile":
        if (req.method !== "POST") {
          break;
        }

        try {
          await this.saveAllCookies();

          await createProfile(this.browser, this.cdp, this.params.filename);

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

        setTimeout(() => process.exit(ExitCodes.Success), 200);
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

await main();
