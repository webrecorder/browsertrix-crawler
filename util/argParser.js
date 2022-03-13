const path = require("path");
const fs = require("fs");
const os = require("os");

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

      "crawlId": {
        alias: "id",
        describe: "A user provided ID for this crawl or crawl configuration (can also be set via CRAWL_ID env var)",
        type: "string",
        default: process.env.CRAWL_ID || os.hostname(),
      },

      "newContext": {
        describe: "The context for each new capture, can be a new: page, window, session or browser.",
        default: "page",
        type: "string"
      },

      "waitUntil": {
        describe: "Puppeteer page.goto() condition to wait for before continuing, can be multiple separate by ','",
        default: "load,networkidle2",
      },

      "depth": {
        describe: "The depth of the crawl for all seeds",
        default: -1,
        type: "number",
      },

      "extraHops": {
        describe: "Number of extra 'hops' to follow, beyond the current scope",
        default: 0,
        type: "number"
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
        describe: "A predfined scope of the crawl. For more customization, use 'custom' and set scopeIncludeRx regexes",
        type: "string",
        choices: ["page", "page-spa", "prefix", "host", "domain", "any", "custom"]
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

      "blockRules": {
        describe: "Additional rules for blocking certain URLs from being loaded, by URL regex and optionally via text match in an iframe",
        type: "array",
        default: [],
      },

      "blockMessage": {
        describe: "If specified, when a URL is blocked, a record with this error message is added instead",
        type: "string",
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

      "behaviorTimeout": {
        describe: "If >0, timeout (in seconds) for in-page behavior will run on each page. If 0, a behavior can run until finish.",
        default: 90,
        type: "number",
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

      "screencastRedis": {
        describe: "If set, will use the state store redis pubsub for screencasting. Requires --redisStoreUrl to be set",
        type: "boolean",
        default: false
      },

      "warcInfo": {
        alias: ["warcinfo"],
        describe: "Optional fields added to the warcinfo record in combined WARCs",
        type: "object"
      },

      "redisStoreUrl": {
        describe: "If set, url for remote redis server to store state. Otherwise, using in-memory store",
        type: "string"
      },

      "saveState": {
        describe: "If the crawl state should be serialized to the crawls/ directory. Defaults to 'partial', only saved when crawl is interrupted",
        type: "string",
        default: "partial",
        choices: ["never", "partial", "always"]
      },

      "saveStateInterval": {
        describe: "If save state is set to 'always', also save state during the crawl at this interval (in seconds)",
        type: "number",
        default: 300,
      },

      "saveStateHistory": {
        describe: "Number of save states to keep during the duration of a crawl",
        type: "number",
        default: 5,
      }
    };
  }

  parseArgs(argv) {
    argv = argv || process.argv;

    if (process.env.CRAWL_ARGS) {
      argv = argv.concat(process.env.CRAWL_ARGS.split(" "));
    }

    let origConfig = {};

    const parsed = yargs(hideBin(argv))
      .usage("crawler [options]")
      .option(this.cliOpts)
      .config("config", "Path to YAML config file", (configPath) => {
        if (configPath === "/crawls/stdin") {
          configPath = process.stdin.fd;
        }
        origConfig = yaml.load(fs.readFileSync(configPath, "utf8"));
        return origConfig;
      })
      .check((argv) => this.validateArgs(argv))
      .argv;

    return {parsed, origConfig};
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

    // log options
    argv.logging = argv.logging.split(",");

    // background behaviors to apply
    const behaviorOpts = {};
    if (typeof argv.behaviors != "object"){
      argv.behaviors = argv.behaviors.split(",");
    }
    argv.behaviors.forEach((x) => behaviorOpts[x] = true);
    if (argv.behaviorTimeout) {
      behaviorOpts.timeout = argv.behaviorTimeout *= 1000;
    }
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
        console.log("Note: to support screencasting with >1 workers, newContext set to 'window' instead of 'page'");
        argv.newContext = NewWindowPage;
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

    if (argv.include) {
      if (argv.scopeType && argv.scopeType !== "custom") {
        console.warn("You've specified a --scopeType and a --scopeIncludeRx / --include regex. The custom scope regex will take precedence, overriding the scopeType");
        argv.scopeType = "custom";
      }
    }

    const scopeOpts = {
      scopeType: argv.scopeType,
      sitemap: argv.sitemap,
      include: argv.include,
      exclude: argv.exclude,
      depth: argv.depth,
      extraHops: argv.extraHops,
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

    return true;
  }
}

module.exports.parseArgs = function(argv) {
  return new ArgParser().parseArgs(argv);
};
