const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const child_process = require("child_process");
const fetch = require("node-fetch");
const AbortController = require("abort-controller");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const Sitemapper = require("sitemapper");
const { v4: uuidv4 } = require("uuid");
const warcio = require("warcio");

const Redis = require("ioredis");

const TextExtract = require("./textextract");
const behaviors = fs.readFileSync("/app/node_modules/browsertrix-behaviors/dist/behaviors.js", "utf-8");

const HTML_TYPES = ["text/html", "application/xhtml", "application/xhtml+xml"];
const WAIT_UNTIL_OPTS = ["load", "domcontentloaded", "networkidle0", "networkidle2"];

const BEHAVIOR_LOG_FUNC = "__bx_log";

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

    // pages file
    this.pagesFH = null;

    // was the limit hit?
    this.limitHit = false;

    this.userAgent = "";
    this.behaviorsLogDebug = false;
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));

    const params = require("yargs")
      .usage("crawler [options]")
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
    let opts = {};
    if (this.params.logging.includes("pywb")) {
      opts = {stdio: "inherit", cwd: this.params.cwd};
    }
    else{
      opts = {stdio: "ignore", cwd: this.params.cwd};
    }

    this.configureUA();
    
    this.headers = {"User-Agent": this.userAgent};

    child_process.spawn("redis-server", {...opts, cwd: "/tmp/"});
    
    child_process.spawnSync("wb-manager", ["init", this.params.collection], opts);

    opts.env = {...process.env, COLL: this.params.collection, ROLLOVER_SIZE: this.params.rolloverSize};
    
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

      "collection": {
        alias: "c",
        describe: "Collection name to crawl to (replay will be accessible under this name in pywb preview)",
        type: "string",
        default: `capture-${new Date().toISOString().slice(0,19)}`.replace(/:/g, "-")
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
        alias: ["generatecdx", "generateCdx"],
        describe: "If set, generate index (CDXJ) for use with pywb after crawl is done",
        type: "boolean",
        default: false,
      },

      "combineWARC": {
        alias: ["combinewarc", "combineWarc"],
        describe: "If set, combine the warcs",
        type: "boolean",
        default: false,
      },
      
      "rolloverSize": {
        describe: "If set, declare the rollover size",
        default: 1000000000,
        type: "number",
      },
      
      "generateWACZ": {
        alias: ["generatewacz", "generateWacz"],
        describe: "If set, generate wacz",
        type: "boolean",
        default: false,
      },
      
      "logging": {
        describe: "Logging options for crawler, can include: stats, pywb, behaviors, behaviors-debug",
        type: "string",
        default: "stats",
      },
    
      "text": {
        describe: "If set, extract text to the pages.jsonl file",
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

      "behaviors": {
        describe: "Which background behaviors to enable on each page",
        default: "autoplay,autofetch,siteSpecific",
        type: "string",
      },

      "profile": {
        describe: "Path to tar.gz file which will be extracted and used as the browser profile",
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
    
    
    // Check that the collection name is valid.
    if (argv.collection.search(/^[\w][\w-]*$/) === -1){
      throw new Error(`\n${argv.collection} is an invalid collection name. Please supply a collection name only using alphanumeric characters and the following characters [_ - ]\n`);
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

    // log options
    argv.logging = argv.logging.split(",");

    // background behaviors to apply
    const behaviorOpts = {};
    argv.behaviors.split(",").forEach((x) => behaviorOpts[x] = true);
    if (argv.logging.includes("behaviors")) {
      behaviorOpts.log = BEHAVIOR_LOG_FUNC;
    } else if (argv.logging.includes("behaviors-debug")) {
      behaviorOpts.log = BEHAVIOR_LOG_FUNC;
      this.behaviorsLogDebug = true;
    }
    this.behaviorOpts = JSON.stringify(behaviorOpts);

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

    if (argv.profile) {
      child_process.execSync("tar xvfz " + argv.profile, {cwd: this.profileDir});
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
      "--disable-popup-blocking"
    ];
  }

  get puppeteerArgs() {
    // Puppeter Options
    return {
      headless: this.params.headless,
      executablePath: CHROME_PATH,
      ignoreHTTPSErrors: true,
      args: this.chromeArgs,
      userDataDir: this.profileDir,
      defaultViewport: null,
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

  _behaviorLog({data, type}) {
    switch (type) {
    case "info":
      console.log(JSON.stringify(data));
      break;

    case "debug":
    default:
      if (this.behaviorsLogDebug) {
        console.log("behavior debug: " + JSON.stringify(data));
      }
    }
  }

  async crawlPage({page, data}) {
    try {
      if (this.emulateDevice) {
        await page.emulate(this.emulateDevice);
      }

      if (this.behaviorOpts) {
        await page.exposeFunction(BEHAVIOR_LOG_FUNC, (logdata) => this._behaviorLog(logdata));
        await page.evaluateOnNewDocument(behaviors + `;\nself.__bx_behaviors.init(${this.behaviorOpts});`);
      }

      // run custom driver here
      await this.driver({page, data, crawler: this});
      
      
      const title = await page.title();
      let text = "";
      if (this.params.text) {
        const client = await page.target().createCDPSession();
        const result = await client.send("DOM.getDocument", {"depth": -1, "pierce": true});
        text = await new TextExtract(result).parseTextFromDom();
      }
    
      await this.writePage(data.url, title, this.params.text, text);

      if (this.behaviorOpts) {
        await Promise.allSettled(page.frames().map(frame => frame.evaluate("self.__bx_behaviors.run();")));
      }

      await this.writeStats();

    } catch (e) {
      console.warn(e);
    }
  }
  
  async createWARCInfo(filename) {
    const warcVersion = "WARC/1.1";
    const type = "warcinfo";
    const packageFileJSON = JSON.parse(await fsp.readFile("../app/package.json"));
    const version = await fsp.readFile("/usr/local/lib/python3.8/site-packages/pywb/version.py", "utf8");
    const pywbVersion = version.split("\n")[0].split("=")[1].trim().replace(/['"]+/g, "");
    const warcioPackageJson = JSON.parse(await fsp.readFile("/app/node_modules/warcio/package.json"));

    const info = {
      "software": `Browsertrix-Crawler ${packageFileJSON["version"]} (with warcio.js ${warcioPackageJson} pywb ${pywbVersion})`,
      "format": "WARC File Format 1.1"
    };
    
    const record = await warcio.WARCRecord.createWARCInfo({filename, type, warcVersion}, info);
    const buffer = await warcio.WARCSerializer.serialize(record, {gzip: true});
    return buffer;
  }
  
  async getFileSize(filename) {
    var stats = await fsp.stat(filename);
    return stats.size;
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
      monitor: this.params.logging.includes("stats")
    });

    this.cluster.task((opts) => this.crawlPage(opts));

    await this.initPages();

    this.queueUrl(this.params.url);

    if (this.params.useSitemap) {
      await this.parseSitemap(this.params.useSitemap);
    }

    await this.cluster.idle();
    await this.cluster.close();

    this.writeStats();

    if (this.pagesFH) {
      await this.pagesFH.close();
    }

    // extra wait for all resources to land into WARCs
    await this.awaitPendingClear();

    if (this.params.combineWARC) {
      await this.combineWARC();
    }

    if (this.params.generateCDX) {
      console.log("Generate CDX");

      child_process.spawnSync("wb-manager", ["reindex", this.params.collection], {stdio: "inherit", cwd: this.params.cwd});
    }
    
    if (this.params.generateWACZ || this.params.generateWacz || this.params.generatewacz ) {
      console.log("Generating WACZ");

      const archiveDir = path.join(this.collDir, "archive");

      // Get a list of the warcs inside
      const warcFileList = await fsp.readdir(archiveDir);
      
      // Build the argument list to pass to the wacz create command
      const waczFilename = this.params.collection.concat(".wacz");
      const waczPath = path.join(this.collDir, waczFilename);
      const argument_list = ["create", "-o", waczPath, "--pages", this.pagesFile, "-f"];
      warcFileList.forEach((val, index) => argument_list.push(path.join(archiveDir, val))); // eslint-disable-line  no-unused-vars
      
      // Run the wacz create command
      child_process.spawnSync("wacz" , argument_list);
      console.log(`WACZ successfully generated and saved to: ${waczFilename}`);
    }
  }

  async writeStats() {
    if (this.params.statsFilename) {
      const total = this.cluster.allTargetCount;
      const workersRunning = this.cluster.workersBusy.length;
      const numCrawled = total - this.cluster.jobQueue.size() - workersRunning;
      const limit = {max: this.params.limit || 0, hit: this.limitHit};
      const stats = {numCrawled, workersRunning, total, limit};

      try {
        await fsp.writeFile(this.params.statsFilename, JSON.stringify(stats, null, 2));
      } catch (err) {
        console.warn("Stats output failed", err);
      }
    }
  }

  async extractLinks(page, selector = "a[href]") {
    let results = [];

    try {
      await Promise.allSettled(page.frames().map(frame => frame.evaluate((selector) => {
        /* eslint-disable-next-line no-undef */
        return [...document.querySelectorAll(selector)].map(elem => elem.href);
      }, selector))).then((linkResults) => {
        linkResults.forEach((linkResult) => {linkResult.value.forEach(link => results.push(link));});});
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

  async initPages() {
    try {
      let createNew = false;

      // create pages dir if doesn't exist and write pages.jsonl header
      if (fs.existsSync(this.pagesDir) != true){
        await fsp.mkdir(this.pagesDir);
        createNew = true;
      }
        
      this.pagesFH = await fsp.open(this.pagesFile, "a");

      if (createNew) {
        const header = {"format": "json-pages-1.0", "id": "pages", "title": "All Pages"};
        if (this.params.text) {
          console.log("creating pages with full text");
          header["hasText"] = true;
        }
        else{
          console.log("creating pages without full text");
          header["hasText"] = false;
        }
        const header_formatted = JSON.stringify(header).concat("\n");
        await this.pagesFH.writeFile(header_formatted);
      }

    } catch(err) {
      console.log("pages/pages.jsonl creation failed", err);
    }
  }

  async writePage(url, title, text, text_content){
    const id = uuidv4();
    const row = {"id": id, "url": url, "title": title};

    if (text == true){
      row["text"] = text_content;
    }
    
    const processedRow = JSON.stringify(row).concat("\n");
    try {
      this.pagesFH.writeFile(processedRow);
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
        console.log(`Skipping HEAD check ${url}, invalid status ${resp.status}`);
        return true;
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

  async awaitPendingClear() {
    console.log("Waiting to ensure pending data is written to WARC...");

    const redis = new Redis("redis://localhost/0");

    while (true) {
      const res = await redis.get(`pywb:${this.params.collection}:pending`);
      if (res === "0" || !res) {
        break;
      }

      console.log(`Still waiting for ${res} pending requests to finish...`);

      await this.sleep(1000);
    }
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

  async combineWARC() {
    console.log("Combining the WARCs");

    // Get the list of created Warcs
    const warcLists = await fsp.readdir(path.join(this.collDir, "archive"));

    console.log(`Combining ${warcLists.length} WARCs...`);

    const fileSizeObjects = []; // Used to sort the created warc by fileSize

    // Go through a list of the created works and create an array sorted by their filesize with the largest file first.
    for (let i = 0; i < warcLists.length; i++) {
      let fileName = path.join(this.collDir, "archive", warcLists[i]);
      let fileSize = await this.getFileSize(fileName);
      fileSizeObjects.push({"fileSize": fileSize, "fileName": fileName});
      fileSizeObjects.sort(function(a, b){
        return b.fileSize - a.fileSize;
      });
    }

    const generatedCombinedWarcs = [];

    // Used to name combined warcs, default to -1 for first increment
    let combinedWarcNumber = -1;

    // write combine WARC to collection root
    let combinedWarcFullPath = "";

    // fileHandler
    let fh = null;

    // Iterate through the sorted file size array.
    for (let j = 0; j < fileSizeObjects.length; j++) {

      // if need to rollover to new warc
      let doRollover = false;

      // set to true for first warc
      if (combinedWarcNumber < 0) {
        doRollover = true;
      } else {
        // Check the size of the existing combined warc.
        const currentCombinedWarcSize = await this.getFileSize(combinedWarcFullPath);

        //  If adding the current warc to the existing combined file creates a file smaller than the rollover size add the data to the combinedWarc
        const proposedWarcSize = fileSizeObjects[j].fileSize + currentCombinedWarcSize;

        doRollover = (proposedWarcSize >= this.params.rolloverSize);
      }

      if (doRollover) {
        // If adding the current warc to the existing combined file creates a file larger than the rollover size do the following: 
        // 1. increment the combinedWarcNumber
        // 2. create the name of the new combinedWarcFile
        // 3. Write the header out to the new file
        // 4. Write out the current warc data to the combinedFile
        combinedWarcNumber = combinedWarcNumber + 1;

        const combinedWarcName = `${this.params.collection}_${combinedWarcNumber}.warc.gz`;

        // write combined warcs to root collection dir as they're output of a collection (like wacz)
        combinedWarcFullPath = path.join(this.collDir, combinedWarcName);

        if (fh) {
          fh.end();
        }

        fh = fs.createWriteStream(combinedWarcFullPath, {flags: "a"});

        generatedCombinedWarcs.push(combinedWarcName);

        const warcBuffer = await this.createWARCInfo(combinedWarcName);
        fh.write(warcBuffer);
      }

      console.log(`Appending WARC ${fileSizeObjects[j].fileName}`);

      const reader = fs.createReadStream(fileSizeObjects[j].fileName);

      const p = new Promise((resolve) => {
        reader.on("end", () => resolve());
      });

      reader.pipe(fh, {end: false});

      await p;
    }

    if (fh) {
      await fh.end();
    }

    console.log(`Combined WARCs saved as: ${generatedCombinedWarcs}`);
  }
}

module.exports.Crawler = Crawler;
