const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const child_process = require("child_process");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const path = require("path");
const fs = require("fs");
const Sitemapper = require("sitemapper");
const { v4: uuidv4 } = require("uuid");

const BackgroundBehaviors = require("./behaviors/bgbehaviors");


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

    // was the limit hit?
    this.limitHit = false;

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


    // root collections dir
    this.collDir = path.join(this.params.cwd, "collections", this.params.collection);

    // pages directory
    this.pagesDir = path.join(this.collDir, "pages");

    // pages file
    this.pagesFile = path.join(this.pagesDir, "pages.jsonl");

    // background behaviors
    this.bgbehaviors = new BackgroundBehaviors(this.params.bgbehaviors || []);
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
      let version = process.env.BROWSER_VERSION;

      try {
        version = child_process.execFileSync("google-chrome", ["--product-version"], {encoding: "utf8"}).trim();
      } catch(e) {
        console.log(e);
      }

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

    this.configureUA();

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
        describe: "Puppeteer page.goto() condition to wait for before continuing, can be multiple separate by ','",
        default: "load,networkidle0",
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
        default: `capture-${new Date().toISOString().slice(0,18)}`.replace(/:/g, "-")
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
      
      "generateWACZ": {
        describe: "If set, generate wacz",
        type: "boolean",
        default: false,
      },
      
      "cwd": {
        describe: "Crawl working directory for captures (pywb root). If not set, defaults to process.cwd()",
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
      },

      "useSitemap": {
        describe: "If enabled, check for sitemaps at /sitemap.xml, or custom URL if URL is specified",
      },

      "statsFilename": {
        describe: "If set, output stats as JSON to this file. (Relative filename resolves to crawl working directory)"
      },

      "bgbehaviors": {
        describe: "Which background behaviors to enable on each page",
        default: "auto-play,auto-fetch",
        type: "string",
      },
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
    // can be multiple separate by comma
    // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
    argv.waitUntil = argv.waitUntil.split(",");

    for (const opt of argv.waitUntil) {
      if (!WAIT_UNTIL_OPTS.includes(opt)) {
        throw new Error("Invalid waitUntil option, must be one of: " + WAIT_UNTIL_OPTS.join(","));
      }
    }

    // background behaviors to apply
    argv.bgbehaviors = argv.bgbehaviors.split(",");

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

    if (argv.useSitemap === true) {
      const url = new URL(argv.url);
      url.pathname = "/sitemap.xml";
      argv.useSitemap = url.href;
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

    // Resolve statsFilename
    if (argv.statsFilename) {
      argv.statsFilename = path.resolve(argv.cwd, argv.statsFilename);
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
      "--disable-features=IsolateOrigins,site-per-process",
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

  async crawlPage({page, data}) {
    try {
      if (this.emulateDevice) {
        await page.emulate(this.emulateDevice);
      }

      const bgbehavior = await this.bgbehaviors.setup(page, this);

      // run custom driver here
      await this.driver({page, data, crawler: this});

      const title = await page.title();
      this.writePage(data.url, title);

      if (bgbehavior) {
        await bgbehavior();
      }

      this.writeStats();

    } catch (e) {
      console.warn(e);
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

    this.cluster.task((opts) => this.crawlPage(opts));

    this.initPages();

    this.queueUrl(this.params.url);

    if (this.params.useSitemap) {
      await this.parseSitemap(this.params.useSitemap);
    }

    await this.cluster.idle();
    await this.cluster.close();

    this.writeStats();

    // extra wait for all resources to land into WARCs
    console.log("Waiting 5s to ensure WARCs are finished");
    await this.sleep(5000);

    if (this.params.generateCDX) {
      console.log("Generate CDX");

      child_process.spawnSync("wb-manager", ["reindex", this.params.collection], {stdio: "inherit", cwd: this.params.cwd});
    }
    
    if (this.params.generateWACZ) {
      console.log("Generating WACZ");

      const archiveDir = path.join(this.collDir, "archive");

      // Get a list of the warcs inside
      const warcFileList = fs.readdirSync(archiveDir);
      
      // Build the argument list to pass to the wacz create command
      const waczFilename = this.params.collection.concat(".wacz");
      const waczPath = path.join(this.collDir, waczFilename);
      const argument_list = ["create", "-o", waczPath, "--pages", this.pagesFile, "-f"];
      warcFileList.forEach((val, index) => argument_list.push(path.join(archiveDir, val)));
      
      // Run the wacz create command
      child_process.spawnSync("wacz" , argument_list);
      console.log(`WACZ successfully generated and saved to: ${waczFilename}`);
    }
  }


  writeStats() {
    if (this.params.statsFilename) {
      const total = this.cluster.allTargetCount;
      const workersRunning = this.cluster.workersBusy.length;
      const numCrawled = total - this.cluster.jobQueue.size() - workersRunning;
      const limit = {max: this.params.limit || 0, hit: this.limitHit};
      const stats = {numCrawled, workersRunning, total, limit};

      try {
        fs.writeFileSync(this.params.statsFilename, JSON.stringify(stats, null, 2));
      } catch (err) {
        console.warn("Stats output failed", err);
      }
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
    this.queueUrls(results);
  }

  queueUrls(urls) {
    try {
      for (const url of urls) {
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
      this.limitHit = true;
      return false;
    }
    this.numLinks++;
    this.cluster.queue({url});
    return true;
  }

  initPages() {
    try {
      // create pages dir if doesn't exist and write pages.jsonl header
      if (!fs.existsSync(this.pagesDir)) {
        fs.mkdirSync(this.pagesDir);
        const header = JSON.stringify({"format": "json-pages-1.0", "id": "pages", "title": "All Pages", "hasText": false}).concat("\n");
        fs.writeFileSync(this.pagesFile, header);
      }
    } catch(err) {
      console.log("pages/pages.jsonl creation failed", err);
    }
  }

  writePage(url, title){
    const id = uuidv4();
    const today = new Date();
    const row = {"id": id, "url": url, "title": title};
    const processedRow = JSON.stringify(row).concat("\n");
    try {
      fs.appendFileSync(this.pagesFile, processedRow);
    }
    catch (err) {
      console.warn("pages/pages.jsonl append failed", err);
    }
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
    await fetch(this.capturePrefix + url, {signal, headers: this.headers});
    abort.abort();
  }

  sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time));
  }

  rxEscape(string) {
    return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  }

  async parseSitemap(url) {
    const sitemapper = new Sitemapper({
      url,
      timeout: 15000,
      requestHeaders: this.headers
    });

    try {
      const { sites } = await sitemapper.fetch();

      this.queueUrls(sites);

    } catch(e) {
      console.log(e);
    }
  }
}

module.exports.Crawler = Crawler;

