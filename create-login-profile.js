#!/usr/bin/env node

const readline = require("readline");
const child_process = require("child_process");

const puppeteer = require("puppeteer-core");
const yargs = require("yargs");

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

  //await new Promise(resolve => setTimeout(resolve, 2000));

  const args = {
    headless: !!params.headless,
    executablePath: "google-chrome",
    ignoreHTTPSErrors: true,
    args: [
      "--no-xshm",
      "--no-sandbox",
      "--disable-background-media-suspend",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=IsolateOrigins,site-per-process",
      "--user-data-dir=/tmp/profile"
    ]
  };

  if (!params.user) {
    params.user = await promptInput("Enter username: ");
  }

  if (!params.password) {
    params.password = await promptInput("Enter password: ", true);
  }

  const browser = await puppeteer.launch(args);

  const page = await browser.newPage();

  const waitUntil =  ["load", "networkidle2"];

  await page.setCacheEnabled(false);

  console.log("loading");

  await page.goto(params.url, {waitUntil});

  console.log("loaded");

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

  await page._client.send("Network.clearBrowserCache");

  if (params.debugScreenshot) {
    await page.screenshot({path: params.debugScreenshot});
  }

  await browser.close();

  console.log("creating profile");

  const profileFilename = params.filename || "/output/profile.tar.gz";

  child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: "/tmp/profile"});
  console.log("done");

  process.exit(0);
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

main();

