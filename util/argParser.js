const path = require("path");
const fs = require("fs");
const child_process = require("child_process");

const yaml = require("js-yaml");
const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const { NewWindowPage} = require("./screencaster");
const { BEHAVIOR_LOG_FUNC, WAIT_UNTIL_OPTS } = require("./constants");
const { ScopedSeed } = require("./seeds");



// ============================================================================
class ArgParser {
  constructor(profileDir) {
    this.profileDir = profileDir;
  }

  get cliOpts() {
    return {
      "seeds": {
        alias: "url",
        describe: "The URL to start crawling from",
        type: "array",
        default: [],
      },

      "seedFile": {
        alias: ["urlFile"],
        describe: "If set, read a list of seed urls, one per line, from the specified",
        type: "string",
      },

      "workers": {
        alias: "w",
        describe: "The number of workers to run in parallel",
        default: 1,
        type: "number",
      },

      "newContext": {
        describe: "The context for each new capture, can be a new: page, window, session or browser.",
        default: "page",
        type: "string"
      },

      "waitUntil": {
        describe: "Puppeteer page.goto() condition to wait for before continuing, can be multiple separate by ','",
        default: "load,networkidle0",
      },

      "depth": {
        describe: "The depth of the crawl for all seeds",
        default: -1,
        type: "number",
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

      "scopeType": {
        describe: "Predefined for which URLs to crawl, can be: prefix, page, host, any, or custom, to use the scopeIncludeRx/scopeExcludeRx",
        type: "string",
      },

      "scopeIncludeRx": {
        alias: "include",
        describe: "Regex of page URLs that should be included in the crawl (defaults to the immediate directory of URL)",
      },

      "scopeExcludeRx": {
        alias: "exclude",
        describe: "Regex of page URLs that should be excluded from the crawl."
      },

      "allowHashUrls": {
        describe: "Allow Hashtag URLs, useful for single-page-application crawling or when different hashtags load dynamic content",
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
        default: path.join(__dirname, "..", "defaultDriver.js"),
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
        alias: "sitemap",
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

      "screencastPort": {
        describe: "If set to a non-zero value, starts an HTTP server with screencast accessible on this port",
        type: "number",
        default: 0
      },

      "warcInfo": {
        alias: ["warcinfo"],
        describe: "If set will record the values in the warcinfo. Currently accepting 'host', 'operator', and 'ip'",
        type: "dict"
      }
    };
  }

  parseArgs(argv) {
    argv = argv || process.argv;

    return yargs(hideBin(argv))
      .usage("crawler [options]")
      .option(this.cliOpts)
      .config("config", "Path to YAML config file", (configPath) => {
        if (configPath === "/crawls/stdin") {
          configPath = process.stdin.fd;
        }
        return yaml.load(fs.readFileSync(configPath, "utf8"));
      })
      .check((argv) => this.validateArgs(argv))
      .argv;
  }


  validateArgs(argv) {
    // Check that the collection name is valid.
    if (argv.collection.search(/^[\w][\w-]*$/) === -1){
      throw new Error(`\n${argv.collection} is an invalid collection name. Please supply a collection name only using alphanumeric characters and the following characters [_ - ]\n`);
    }

    argv.timeout *= 1000;

    // waitUntil condition must be: load, domcontentloaded, networkidle0, networkidle2
    // can be multiple separate by comma
    // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
    if (typeof argv.waitUntil != "object"){
      argv.waitUntil = argv.waitUntil.split(",");
    }

    for (const opt of argv.waitUntil) {
      if (!WAIT_UNTIL_OPTS.includes(opt)) {
        throw new Error("Invalid waitUntil option, must be one of: " + WAIT_UNTIL_OPTS.join(","));
      }
    }

    if (argv.warcInfo){
      argv.warcInfo = JSON.parse(argv.warcInfo);
      for (const key in argv.warcInfo) {
        if (!(key in ["operator", "host", "ip"])){
          console.log(`${key} is not supported and will not be recorded. Only operator, host and ip are recognized at this time`);
        }
      }
    }

    // log options
    argv.logging = argv.logging.split(",");

    // background behaviors to apply
    const behaviorOpts = {};
    if (typeof argv.behaviors != "object"){
      argv.behaviors = argv.behaviors.split(",");
    }
    argv.behaviors.forEach((x) => behaviorOpts[x] = true);
    if (argv.logging.includes("behaviors")) {
      behaviorOpts.log = BEHAVIOR_LOG_FUNC;
    } else if (argv.logging.includes("behaviors-debug")) {
      behaviorOpts.log = BEHAVIOR_LOG_FUNC;
      argv.behaviorsLogDebug = true;
    }
    argv.behaviorOpts = JSON.stringify(behaviorOpts);

    if (!argv.newContext) {
      argv.newContext = "page";
    }

    switch (argv.newContext) {
    case "page":
      argv.newContext = Cluster.CONCURRENCY_PAGE;
      if (argv.screencastPort && argv.workers > 1) {
        console.warn("Note: Screencast with >1 workers and default page context may only show one page at a time. To fix, add '--newContext window' to open each page in a new window");
      }
      break;

    case "session":
      argv.newContext = Cluster.CONCURRENCY_CONTEXT;
      break;

    case "browser":
      argv.newContext = Cluster.CONCURRENCY_BROWSER;
      break;

    case "window":
      argv.newContext = NewWindowPage;
      break;

    default:
      throw new Error("Invalid newContext, must be one of: page, session, browser");
    }

    if (argv.mobileDevice) {
      argv.emulateDevice = puppeteer.devices[argv.mobileDevice];
      if (!argv.emulateDevice) {
        throw new Error("Unknown device: " + argv.mobileDevice);
      }
    }

    if (argv.seedFile) {
      const urlSeedFile = fs.readFileSync(argv.seedFile, "utf8");
      const urlSeedFileList = urlSeedFile.split("\n");

      if (typeof(argv.seeds) === "string") {
        argv.seeds = [argv.seeds];
      }

      for (const seed of urlSeedFileList) {
        if (seed) {
          argv.seeds.push(seed);
        }
      }
    }

    if (argv.include || argv.exclude) {
      if (argv.scopeType && argv.scopeType !== "custom") {
        console.warn("You've specified a --scopeType and a --scopeIncludeRx or --scopeExcludeRx regex. The custom scope regex will take precedence, overriding the scopeType");
        argv.scopeType = "custom";
      }
    }

    const scopeOpts = {
      scopeType: argv.scopeType,
      sitemap: argv.sitemap,
      include: argv.include,
      exclude: argv.exclude,
      depth: argv.depth,
    };

    argv.scopedSeeds = [];

    for (let seed of argv.seeds) {
      if (typeof(seed) === "string") {
        seed = {url: seed};
      }
      argv.scopedSeeds.push(new ScopedSeed({...scopeOpts, ...seed}));
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
}


module.exports.parseArgs = function(profileDir, argv) {
  return new ArgParser(profileDir).parseArgs(argv);
};
