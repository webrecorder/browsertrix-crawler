const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const child_process = require("child_process");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const path = require("path");

const HTML_TYPES = ["text/html", "application/xhtml", "application/xhtml+xml"];
const WAIT_UNTIL_OPTS = ["load", "domcontentloaded", "networkidle0", "networkidle2"];

const CHROME_PATH = "google-chrome";

// to ignore HTTPS error for HEAD check
const HTTPS_AGENT = require("https").Agent({
  rejectUnauthorized: false,
});

const HTTP_AGENT = require("http").Agent();


// ============================================================================
class Crawler {
  constructor() {
    this.headers = {};

    this.seenList = new Set();

    this.emulateDevice = null;

    // links crawled counter
    this.numLinks = 0;

    this.monitor = true;

    this.userAgent = "";
    this.headers = {};

    const params = require("yargs")
      .usage("browsertrix-crawler [options]")
      .option(this.cliOpts)
      .check((argv) => this.validateArgs(argv)).argv;

    console.log("Exclusions Regexes: ", params.exclude);
    console.log("Scope Regexes: ", params.scope);

    this.params = params;
    this.capturePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/${this.params.collection}/record/id_/`;
  }

  configureUA() {
    // override userAgent
    if (this.params.userAgent) {

      if (this.emulateDevice) {
        this.emulateDevice.userAgent = this.params.userAgent;
      }

      this.userAgent = this.params.userAgent;
      return;
    }

    // if device set, it overrides the default Chrome UA
    if (this.emulateDevice) {
      this.userAgent = this.emulateDevice.userAgent;
    } else {
      let version = "84";

      try {
        version = child_process.execFileSync("google-chrome", ["--product-version"], {encoding: "utf8"}).trim();
      } catch(e) {}

      this.userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    }

    // suffix to append to default userAgent
    if (this.params.userAgentSuffix) {
      this.userAgent += " " + this.params.userAgentSuffix;

      if (this.emulateDevice) {
        this.emulateDevice.userAgent += " " + this.params.userAgentSuffix;
      }
    }
  }

  bootstrap() {
    const opts = {stdio: "ignore", cwd: this.params.cwd};

    this.userAgent = this.configureUA();

    this.headers = {"User-Agent": this.userAgent};

    child_process.spawn("redis-server", {...opts, cwd: "/tmp/"});

    child_process.spawnSync("wb-manager", ["init", this.params.collection], opts);

    opts.env = {...process.env, COLL: this.params.collection};

    child_process.spawn("uwsgi", [path.join(__dirname, "uwsgi.ini")], opts);

    if (!this.params.headless) {
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
  }

  get cliOpts() {
    return {
      "url": {
        alias: "u",
        describe: "The URL to start crawling from",
        type: "string",
        demandOption: true,
      },

      "workers": {
        alias: "w",
        describe: "The number of workers to run in parallel",
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
      },

      "collection": {
        alias: "c",
        describe: "Collection name to crawl to (replay will be accessible under this name in pywb preview)",
        type: "string",
        default: "capture"
      },

      "headless": {
        describe: "Run in headless mode, otherwise start xvfb",
        type: "boolean",
        default: false,
      },

      "driver": {
        describe: "JS driver for the crawler",
        type: "string",
        default: path.join(__dirname, "defaultDriver.js"),
      },

      "generateCDX": {
        describe: "If set, generate index (CDXJ) for use with pywb after crawl is done",
        type: "boolean",
        default: false,
      },

      "cwd": {
        describe: "Crawl working directory for captures (pywb root). If not set, defaults to process.cwd",
        type: "string",
        default: process.cwd(),
      },

      "mobileDevice": {
        describe: "Emulate mobile device by name from: https://github.com/puppeteer/puppeteer/blob/main/src/common/DeviceDescriptors.ts",
        type: "string",
      },

      "userAgent": {
        describe: "Override user-agent with specified string",
        type: "string",
      },

      "userAgentSuffix": {
        describe: "Append suffix to existing browser user-agent (ex: +MyCrawler, info@example.com)",
        type: "string",
      }
    };
  }

  validateUserUrl(url) {
    url = new URL(url);

    if (url.protocol !== "http:" && url.protocol != "https:") {
      throw new Error("URL must start with http:// or https://");
    }

    return url.href;
  }

  validateArgs(argv) {
    if (argv.url) {
      // Scope for crawl, default to the domain of the URL
      // ensure valid url is used (adds trailing slash if missing)
      //argv.seeds = [Crawler.validateUserUrl(argv.url)];
      argv.url = this.validateUserUrl(argv.url);
    }

    if (!argv.scope) {
      //argv.scope = url.href.slice(0, url.href.lastIndexOf("/") + 1);
      argv.scope = [new RegExp("^" + this.rxEscape(argv.url.slice(0, argv.url.lastIndexOf("/") + 1)))];
    }

    argv.timeout *= 1000;

    // waitUntil condition must be: load, domcontentloaded, networkidle0, networkidle2
    // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
    if (!WAIT_UNTIL_OPTS.includes(argv.waitUntil)) {
      throw new Error("Invalid waitUntil, must be one of: " + WAIT_UNTIL_OPTS.join(","));
    }

    if (!argv.newContext) {
      argv.newContext = "page";
    }

    switch (argv.newContext) {
    case "page":
      argv.newContext = Cluster.CONCURRENCY_PAGE;
      break;

    case "session":
      argv.newContext = Cluster.CONCURRENCY_CONTEXT;
      break;

    case "browser":
      argv.newContext = Cluster.CONCURRENCY_BROWSER;
      break;

    default:
      throw new Error("Invalid newContext, must be one of: page, session, browser");
    }

    if (argv.mobileDevice) {
      this.emulateDevice = puppeteer.devices[argv.mobileDevice];
      if (!this.emulateDevice) {
        throw new Error("Unknown device: " + argv.mobileDevice);
      }
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
  }

  get chromeArgs() {
    // Chrome Flags, including proxy server
    return [
      "--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
      `--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`,
      "--no-sandbox",
      "--disable-background-media-suspend",
      "--autoplay-policy=no-user-gesture-required",
    ];
  }

  get puppeteerArgs() {
    // Puppeter Options
    return {
      headless: this.params.headless,
      executablePath: CHROME_PATH,
      ignoreHTTPSErrors: true,
      args: this.chromeArgs
    };
  }

  async run() {
    this.bootstrap();

    try {
      await this.crawl();
      process.exit(0);
    } catch(e) {
      console.error("Crawl failed");
      console.error(e);
      process.exit(1);
    }
  }

  async crawl() {
    try {
      this.driver = require(this.params.driver);
    } catch(e) {
      console.log(e);
      return;
    }

    // Puppeteer Cluster init and options
    this.cluster = await Cluster.launch({
      concurrency: this.params.newContext,
      maxConcurrency: this.params.workers,
      skipDuplicateUrls: true,
      timeout: this.params.timeout * 2,
      puppeteerOptions: this.puppeteerArgs,
      puppeteer,
      monitor: this.monitor
    });

    this.cluster.task(async (opts) => {
      try {
        await this.driver({...opts, crawler: this});
      } catch (e) {
        console.warn(e);
      }
    });

    this.queueUrl(this.params.url);

    await this.cluster.idle();
    await this.cluster.close();

    // extra wait for all resources to land into WARCs
    console.log("Waiting 5s to ensure WARCs are finished");
    await this.sleep(5000);

    if (this.params.generateCDX) {
      console.log("Generate CDX");

      child_process.spawnSync("wb-manager", ["reindex", this.params.collection], {stdio: "inherit", cwd: this.params.cwd});
    }
  }

  async extractLinks(page, selector = "a[href]") {
    let results = null;

    try {
      results = await page.evaluate((selector) => {
        /* eslint-disable-next-line no-undef */
        return [...document.querySelectorAll(selector)].map(elem => elem.href);
      }, selector);
    } catch (e) {
      console.warn("Link Extraction failed", e);
      return;
    }

    try {
      for (const url of results) {
        const captureUrl = this.shouldCrawl(url);

        if (captureUrl) {
          if (!this.queueUrl(captureUrl)) {
            break;
          }
        }
      }
    } catch (e) {
      console.log("Queuing Error: ", e);
    }
  }

  queueUrl(url) {
    this.seenList.add(url);
    if (this.numLinks >= this.params.limit && this.params.limit > 0) {
      return false;
    }
    this.numLinks++;
    this.cluster.queue({url});
    return true;
  }

  shouldCrawl(url) {
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
    if (this.seenList.has(url)) {
      return false;
    }

    let inScope = false;

    // check scopes
    for (const s of this.params.scope) {
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
    for (const e of this.params.exclude) {
      if (e.exec(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return false;
      }
    }

    return url;
  }

  resolveAgent(urlParsed) {
    return urlParsed.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
  }

  async isHTML(url) {
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        headers: this.headers,
        agent: this.resolveAgent
      });

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

      return false;
    } catch(e) {
      console.log("HTML Check error", e);
      // can't confirm not html, so try in browser
      return true;
    }
  }

  async directFetchCapture(url) {
    //console.log(`Direct capture: ${this.capturePrefix}${url}`);
    const abort = new AbortController();
    const signal = abort.signal;
    const resp2 = await fetch(this.capturePrefix + url, {signal, headers: this.headers});
    abort.abort();
  }

  sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
  }

  rxEscape(string) {
    return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  }
}

module.exports.Crawler = Crawler;

