import child_process from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import request from "request";
import { initStorage } from "./storage.js";
import { Logger } from "./logger.js";

const logger = new Logger();

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));

export async function loadProfile(profileFilename) {
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

export function saveProfile(profileFilename) {
  child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: profileDir});
}

export function getBrowserExe() {
  const files = [process.env.BROWSER_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  for (const file of files) {
    if (file && fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}



export function getDefaultUA() {
  let version = process.env.BROWSER_VERSION;

  try {
    version = child_process.execFileSync(getBrowserExe(), ["--version"], {encoding: "utf8"});
    version = version.match(/[\d.]+/)[0];
  } catch(e) {
    logger.error("Error getting default UserAgent", e);
  }

  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}




// from https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromium.ts#L327
const DEFAULT_PLAYWRIGHT_FLAGS = [
  "--disable-field-trial-config", // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/README.md
  "--disable-background-networking",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache", // Avoids surprises like main request not being intercepted during page.goBack().
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  // AvoidUnnecessaryBeforeUnloadCheckSync - https://github.com/microsoft/playwright/issues/14047
  // Translate - https://github.com/microsoft/playwright/issues/16126
  "--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate",
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
  "--no-startup-window",
  "--password-store=basic",
  "--use-mock-keychain",
  // See https://chromium-review.googlesource.com/c/chromium/src/+/2436773
  "--no-service-autorun",
  "--export-tagged-pdf"
];


export function chromeArgs (proxy, userAgent=null, extraArgs=[]) {
  // Chrome Flags, including proxy server
  const args = [
    ...DEFAULT_PLAYWRIGHT_FLAGS,
    ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean),
    //"--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
    "--no-sandbox",
    "--disable-background-media-suspend",
    "--remote-debugging-port=9221",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-site-isolation-trials",
    `--user-agent=${userAgent || getDefaultUA()}`,
    ...extraArgs,
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
  }

  return args;
}


export async function evaluateWithCLI(frame, funcString) {
  const context = await frame.executionContext();
  const url = frame.url();

  // from puppeteer _evaluateInternal() but with includeCommandLineAPI: true
  const contextId = context._contextId;
  const expression = funcString + "\n//# sourceURL=__puppeteer_evaluation_script__";

  const { exceptionDetails, result: remoteObject } = await context._client
    .send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });

  if (exceptionDetails) {
    const details = exceptionDetails.stackTrace || {};
    details.url = url;
    logger.error(
      "Script Evaluation Failed: " + exceptionDetails.text, details
    );
  }

  return remoteObject.value;
}


export async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}





