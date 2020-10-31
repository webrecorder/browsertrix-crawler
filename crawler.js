const fs = require("fs");
const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const child_process = require("child_process");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");

const HTML_TYPES = ["text/html", "application/xhtml", "application/xhtml+xml"];
const WAIT_UNTIL_OPTS = ["load", "domcontentloaded", "networkidle0", "networkidle2"];
const NEW_CONTEXT_OPTS = ["page", "session", "browser"];
const CHROME_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.89 Safari/537.36";

// to ignore HTTPS error for HEAD check
const HTTPS_AGENT = require("https").Agent({
  rejectUnauthorized: false,
});

process.once('SIGINT', (code) => {
  console.log('SIGINT received, exiting');
  process.exit(1);
});

process.once('SIGTERM', (code) => {
  console.log('SIGTERM received, exiting');
  process.exit(1);
});


const autoplayScript = fs.readFileSync("./autoplay.js", "utf-8");


// prefix for direct capture via pywb
const capturePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/capture/record/id_/`;
const headers = {"User-Agent": CHROME_USER_AGENT};


async function run(params) {
  // Chrome Flags, including proxy server
  const args = [
    "--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
    `--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`,
    "--no-sandbox",
    "--disable-background-media-suspend",
    "--autoplay-policy=no-user-gesture-required",
  ];

  // Puppeter Options
  const puppeteerOptions = {
    headless: true,
    executablePath: "/opt/google/chrome/google-chrome",
    ignoreHTTPSErrors: true,
    args
  };

  // params
  const { url, waitUntil, timeout, scope, limit, exclude, scroll, newContext } = params;

  let concurrency = Cluster.CONCURRENCY_PAGE;

  switch (newContext) {
    case "page":
      concurrency = Cluster.CONCURRENCY_PAGE;
      break;

    case "session":
      concurrency = Cluster.CONCURRENCY_CONTEXT;
      break;

    case "browser":
      concurrency = Cluster.CONCURRENCY_BROWSER;
      break;
  }

  // Puppeteer Cluster init and options
  const cluster = await Cluster.launch({
    concurrency,
    maxConcurrency: Number(params.workers) || 1,
    skipDuplicateUrls: true,
    // total timeout for cluster
    timeout: timeout * 2,
    puppeteerOptions,
    puppeteer,
    monitor: true
  });

  // Maintain own seen list
  const seenList = new Set();

  //console.log("Limit: " + limit);

  // links crawled counter
  let numLinks = 0;

  // Crawl Task
  cluster.task(async ({page, data}) => {
    const {url} = data;

    if (!await htmlCheck(url, capturePrefix)) {
      return;
    }

    //page.on('console', message => console.log(`${message.type()} ${message.text()}`));
    //page.on('pageerror', message => console.warn(message));
    //page.on('error', message => console.warn(message));
    //page.on('requestfailed', message => console.warn(message._failureText));
    const mediaResults = [];

    await page.exposeFunction('__crawler_queueUrls', (url) => {
      mediaResults.push(directCapture(url));
    });

    let waitForVideo = false;

    await page.exposeFunction('__crawler_autoplayLoad', (url) => {
      console.log("*** Loading autoplay URL: " + url);
      waitForVideo = true;
    });

    try {
      await page.evaluateOnNewDocument(autoplayScript);
    } catch(e) {
      console.log(e);
    }

    try {
      await page.goto(url, {waitUntil, timeout});
    } catch (e) {
      console.log(`Load timeout for ${url}`);
    }

    try {
      await Promise.all(mediaResults);
    } catch (e) {
      console.log(`Error loading media URLs`, e);
    }

    if (waitForVideo) {
      console.log("Extra wait 15s for video loading");
      await sleep(15000);
    }

    if (scroll) {
      try {
        await Promise.race([page.evaluate(autoScroll), sleep(30000)]);
      } catch (e) {
        console.warn("Behavior Failed", e);
      }
    }

    let results = null;

    try {
      results = await page.evaluate(() => {
        return [...document.querySelectorAll('a[href]')].map(el => ({ url: el.href}))
      });
    } catch (e) {
      console.warn("Link Extraction failed", e);
      return;
    }

    try {
      for (data of results) {
        const newUrl = shouldCrawl(scope, seenList, data.url, exclude);

        if (newUrl) {
          seenList.add(newUrl);
          if (numLinks++ >= limit && limit > 0) {
            break;
          }
          cluster.queue({url: newUrl});
        }
      }
    } catch (e) {
      console.log("Queuing Error: " + e);
    }
  });

  numLinks++;
  cluster.queue({url});

  await cluster.idle();
  await cluster.close();

  // extra wait for all resources to land into WARCs
  console.log("Waiting 30s to ensure WARCs are finished");
  await sleep(30000);
}


function shouldCrawl(scope, seenList, url, exclude) {
  try {
    url = new URL(url);
  } catch(e) {
    return false;
  }

  // remove hashtag
  url.hash = "";

  // only queue http/https URLs
  if (url.protocol != "http:" && url.protocol != "https:") {
    return false;
  }

  url = url.href;

  // skip already crawled
  if (seenList.has(url)) {
    return false;
  }

  let inScope = false;

  // check scopes
  for (const s of scope) {
    if (s.exec(url)) {
      inScope = true;
      break;
    }
  }

  if (!inScope) {
    //console.log(`Not in scope ${url} ${scope}`);
    return false;
  }

  // check exclusions
  for (const e of exclude) {
    if (e.exec(url)) {
      //console.log(`Skipping ${url} excluded by ${e}`);
      return false;
    }
  }

  return url;
}

async function htmlCheck(url, capturePrefix) {
  try {
    const agent = url.startsWith("https:") ? HTTPS_AGENT : null;

    const resp = await fetch(url, {method: "HEAD", headers, agent});

    if (resp.status >= 400) {
      console.log(`Skipping ${url}, invalid status ${resp.status}`);
      return false;
    }

    const contentType = resp.headers.get("Content-Type");

    // just load if no content-type
    if (!contentType) {
      return true;
    }

    const mime = contentType.split(";")[0];

    if (HTML_TYPES.includes(mime)) {
      return true;
    }

    // capture directly
    await directCapture(url);

    return false;
  } catch(e) {
    console.log("HTML Check error", e);
    // can't confirm not html, so try in browser
    return true;
  }
}

async function directCapture(url) {
  console.log(`Direct capture: ${capturePrefix}${url}`);
  const abort = new AbortController();
  const signal = abort.signal;
  const resp2 = await fetch(capturePrefix + url, {signal, headers});
  abort.abort();
}



async function autoScroll() {
  const canScrollMore = () =>
    self.scrollY + self.innerHeight <
    Math.max(
      self.document.body.scrollHeight,
      self.document.body.offsetHeight,
      self.document.documentElement.clientHeight,
      self.document.documentElement.scrollHeight,
      self.document.documentElement.offsetHeight
    );

  const scrollOpts = { top: 250, left: 0, behavior: 'auto' };

  while (canScrollMore()) {
    self.scrollBy(scrollOpts);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}


async function main() {
  const params = require('yargs')
  .usage("browsertrix-crawler [options]")
  .options({
    "url": {
      alias: "u",
      describe: "The URL to start crawling from",
      demandOption: true,
      type: "string",
    },

    "workers": {
      alias: "w",
      describe: "The number of workers to run in parallel",
      demandOption: false,
      default: 1,
      type: "number",
    },

    "newContext": {
      describe: "The context for each new capture, can be a new: page, session or browser.",
      default: "page",
      type: "string"
    },

    "waitUntil": {
      describe: "Puppeteer page.goto() condition to wait for before continuing",
      default: "load",
    },

    "limit": {
      describe: "Limit crawl to this number of pages",
      default: 0,
      type: "number",
    },

    "timeout": {
      describe: "Timeout for each page to load (in seconds)",
      default: 90,
      type: "number",
    },

    "scope": {
      describe: "Regex of page URLs that should be included in the crawl (defaults to the immediate directory of URL)",
    },

    "exclude": {
      describe: "Regex of page URLs that should be excluded from the crawl."
    },

    "scroll": {
      describe: "If set, will autoscroll to bottom of the page",
      type: "boolean",
      default: false,

    }}).check((argv, option) => {
      // Scope for crawl, default to the domain of the URL
      const url = new URL(argv.url);

      if (url.protocol !== "http:" && url.protocol != "https:") {
        throw new Error("URL must start with http:// or https://");
      }

      // ensure valid url is used (adds trailing slash if missing)
      argv.url = url.href;

      if (!argv.scope) {
        //argv.scope = url.href.slice(0, url.href.lastIndexOf("/") + 1);
        argv.scope = [new RegExp("^" + rxEscape(url.href.slice(0, url.href.lastIndexOf("/") + 1)))];
      }

      argv.timeout *= 1000;

      // waitUntil condition must be: load, domcontentloaded, networkidle0, networkidle2
      // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
      if (!WAIT_UNTIL_OPTS.includes(argv.waitUntil)) {
        throw new Error("Invalid waitUntil, must be one of: " + WAIT_UNTIL_OPTS.join(","));
      }

      if (!NEW_CONTEXT_OPTS.includes(argv.newContext)) {
        throw new Error("Invalid newContext, must be one of: " + NEW_CONTEXT_OPTS.join(","));
      }

      // Support one or multiple exclude
      if (argv.exclude) {
        if (typeof(argv.exclude) === "string") {
          argv.exclude = [new RegExp(argv.exclude)];
        } else {
          argv.exclude = argv.exclude.map(e => new RegExp(e));
        }
      } else {
        argv.exclude = [];
      }

      // Support one or multiple scopes
      if (argv.scope) {
        if (typeof(argv.scope) === "string") {
          argv.scope = [new RegExp(argv.scope)];
        } else {
          argv.scope = argv.scope.map(e => new RegExp(e));
        }
      } else {
        argv.scope = [];
      }

      return true;
    })
  .argv;

  console.log("Exclusions Regexes: ", params.exclude);
  console.log("Scope Regexes: ", params.scope);

  try {
    await run(params);
    process.exit(0);
  } catch(e) {
    console.error("Crawl failed");
    console.error(e);
    process.exit(1);
  }
}

function rxEscape(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}


main();


