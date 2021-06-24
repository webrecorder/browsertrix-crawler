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
  get cliOpts() {
    return {
      "seeds": {
        alias: "url",
        describe: "The URL to start crawling from",
        type: "array",
        default: [],
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

      "maxDepth": {
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

      "scope": {
        describe: "Regex of page URLs that should be included in the crawl (defaults to the immediate directory of URL)",
      },

      "scopeType": {
        describe: "Simplified scope for which URLs to crawl, can be: prefix, page, host, any",
        type: "string",
        default: "prefix",
      },

      "exclude": {
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
      
      "urlFile": {
        alias: ["urlfile", "url-file", "url-list"],
        describe: "If set, read a list of urls from the passed file INSTEAD of the url from the --url flag.",
        type: "string",
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

      "screencastPort": {
        describe: "If set to a non-zero value, starts an HTTP server with screencast accessible on this port",
        type: "number",
        default: 0
      },
    };
  }

  parseArgs(argv) {
    argv = argv || process.argv;
    
    return yargs(hideBin(argv))
      .usage("crawler [options]")
      .option(this.cliOpts)
      .config("yamlConfig", (configPath) => {
        return yaml.safeLoad(fs.readFileSync(configPath, "utf-8"));
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
      this.behaviorsLogDebug = true;
    }
    this.behaviorOpts = JSON.stringify(behaviorOpts);

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
      this.emulateDevice = puppeteer.devices[argv.mobileDevice];
      if (!this.emulateDevice) {
        throw new Error("Unknown device: " + argv.mobileDevice);
      }
    }

    if (argv.urlFile) {
      const urlSeedFile = fs.readFileFile(argv.urlFile, "utf8");
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

    const scopeOpts = {
      type: argv.scopeType,
      sitemap: argv.useSitemap,
      include: argv.scope,
      exclude: argv.exclude,
      depth: argv.maxDepth,
    };

    if (argv.scope && argv.scopeType) {
      console.warn("You've specified a --scopeType and a --scope regex. The custom scope regex will take precedence, overriding the scopeType");
    }

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

  
module.exports.parseArgs = function(argv) {
  return new ArgParser().parseArgs(argv);
};
