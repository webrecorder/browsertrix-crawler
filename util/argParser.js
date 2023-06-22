import path from "path";
import fs from "fs";
import os from "os";

import yaml from "js-yaml";
import { KnownDevices as devices } from "puppeteer-core";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { BEHAVIOR_LOG_FUNC, WAIT_UNTIL_OPTS } from "./constants.js";
import { ScopedSeed } from "./seeds.js";
import { interpolateFilename } from "./storage.js";
import { screenshotTypes } from "./screenshots.js";
import { logger } from "./logger.js";


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
        describe: "Deprecated as of 0.8.0, any values passed will be ignored",
        default: null,
        type: "string"
      },

      "waitUntil": {
        describe: "Puppeteer page.goto() condition to wait for before continuing, can be multiple separated by ','",
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

      "pageLimit": {
        alias: "limit",
        describe: "Limit crawl to this number of pages",
        default: 0,
        type: "number",
      },

      "maxPageLimit": {
        describe: "Maximum pages to crawl, overriding  pageLimit if both are set",
        default: 0,
        type: "number",
      },

      "pageLoadTimeout": {
        alias: "timeout",
        describe: "Timeout for each page to load (in seconds)",
        default: 1000,
        type: "number",
      },

      "scopeType": {
        describe: "A predefined scope of the crawl. For more customization, use 'custom' and set scopeIncludeRx regexes",
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

      "blockAds": {
        alias: "blockads",
        describe: "If set, block advertisements from being loaded (based on Stephen Black's blocklist)",
        type: "boolean",
        default: false,
      },

      "adBlockMessage": {
        describe: "If specified, when an ad is blocked, a record with this error message is added instead",
        type: "string",
      },

      "collection": {
        alias: "c",
        describe: "Collection name to crawl to (replay will be accessible under this name in pywb preview)",
        type: "string",
        default: "crawl-@ts"
      },

      "headless": {
        describe: "Run in headless mode, otherwise start xvfb",
        type: "boolean",
        default: false,
      },

      "driver": {
        describe: "JS driver for the crawler",
        type: "string",
        default: "./defaultDriver.js",
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
        describe: "Logging options for crawler, can include: stats (enabled by default), jserrors, pywb, debug",
        type: "string",
        default: "stats",
      },

      "logLevel": {
        describe: "Comma-separated list of log levels to include in logs",
        type: "string",
        default: "",
      },

      "context": {
        describe: "Comma-separated list of contexts to include in logs",
        type: "string",
        default: "",
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
        default: "autoplay,autofetch,autoscroll,siteSpecific",
        type: "string",
      },

      "behaviorTimeout": {
        describe: "If >0, timeout (in seconds) for in-page behavior will run on each page. If 0, a behavior can run until finish.",
        default: 1000,
        type: "number",
      },

      "pageExtraDelay": {
        alias: "delay",
        describe: "If >0, amount of time to sleep (in seconds) after behaviors before moving on to next page",
        default: 0,
        type: "number",
      },

      "profile": {
        describe: "Path to tar.gz file which will be extracted and used as the browser profile",
        type: "string",
      },

      "screenshot": {
        describe: "Screenshot options for crawler, can include: view, thumbnail, fullPage (comma-separated list)",
        type: "string",
        default: "",
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
        type: "string",
        default: "redis://localhost:6379/0"
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
      },

      "sizeLimit": {
        describe: "If set, save state and exit if size limit exceeds this value",
        type: "number",
        default: 0,
      },

      "diskUtilization": {
        describe: "If set, save state and exit if disk utilization exceeds this percentage value",
        type: "number",
        default: 90,
      },

      "timeLimit": {
        describe: "If set, save state and exit after time limit, in seconds",
        type: "number",
        default: 0,
      },

      "healthCheckPort": {
        describe: "port to run healthcheck on",
        type: "number",
        default: 0,
      },

      "overwrite": {
        describe: "overwrite current crawl data: if set, existing collection directory will be deleted before crawl is started",
        type: "boolean",
        default: false
      },

      "waitOnDone": {
        describe: "if set, wait for interrupt signal when finished instead of exiting",
        type: "boolean",
        default: false
      },

      "netIdleWait": {
        describe: "if set, wait for network idle after page load and after behaviors are done (in seconds). if -1 (default), determine based on scope",
        type: "number",
        default: -1
      },

      "lang": {
        describe: "if set, sets the language used by the browser, should be ISO 639 language[-country] code",
        type: "string"
      },

      "title": {
        describe: "If set, write supplied title into WACZ datapackage.json metadata",
        type: "string"
      },

      "description": {
        alias: ["desc"],
        describe: "If set, write supplied description into WACZ datapackage.json metadata",
        type: "string"
      },

      "originOverride": {
        describe: "if set, will redirect requests from each origin in key to origin in the value, eg. --originOverride https://host:port=http://alt-host:alt-port",
        type: "array",
        default: [],
      },

      "logErrorsToRedis": {
        describe: "If set, write error messages to redis",
        type: "boolean",
        default: false,
      },

      "failOnFailedSeed": {
        describe: "If set, crawler will fail with exit code 1 if any seed fails",
        type: "boolean",
        default: false
      }
    };
  }

  parseArgs(argv) {
    argv = argv || process.argv;

    if (process.env.CRAWL_ARGS) {
      argv = argv.concat(this.splitCrawlArgsQuoteSafe(process.env.CRAWL_ARGS));
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

  splitCrawlArgsQuoteSafe(crawlArgs) {
    // Split process.env.CRAWL_ARGS on spaces but retaining spaces within double quotes
    const regex = /"[^"]+"|[^\s]+/g;
    return crawlArgs.match(regex).map(e => e.replace(/"(.+)"/, "$1"));
  }

  validateArgs(argv) {
    argv.collection = interpolateFilename(argv.collection, argv.crawlId);

    // Check that the collection name is valid.
    if (argv.collection.search(/^[\w][\w-]*$/) === -1){
      logger.fatal(`\n${argv.collection} is an invalid collection name. Please supply a collection name only using alphanumeric characters and the following characters [_ - ]\n`);
    }

    // waitUntil condition must be: load, domcontentloaded, networkidle0, networkidle2
    // can be multiple separate by comma
    // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
    if (typeof argv.waitUntil != "object"){
      argv.waitUntil = argv.waitUntil.split(",");
    }

    for (const opt of argv.waitUntil) {
      if (!WAIT_UNTIL_OPTS.includes(opt)) {
        logger.fatal("Invalid waitUntil option, must be one of: " + WAIT_UNTIL_OPTS.join(","));
      }
    }

    // validate screenshot options
    if (argv.screenshot) {
      const passedScreenshotTypes = argv.screenshot.split(",");
      argv.screenshot = [];
      passedScreenshotTypes.forEach((element) => {
        if (element in screenshotTypes) {
          argv.screenshot.push(element);
        } else {
          logger.warn(`${element} not found in ${screenshotTypes}`);
        }
      });
    }

    // log options
    argv.logging = argv.logging.split(",");
    argv.logLevel = argv.logLevel ? argv.logLevel.split(",") : [];
    argv.context = argv.context ? argv.context.split(",") : [];

    // background behaviors to apply
    const behaviorOpts = {};
    if (typeof argv.behaviors != "object"){
      argv.behaviors = argv.behaviors.split(",");
    }
    argv.behaviors.forEach((x) => behaviorOpts[x] = true);
    behaviorOpts.log = BEHAVIOR_LOG_FUNC;
    argv.behaviorOpts = JSON.stringify(behaviorOpts);

    if (argv.newContext) {
      logger.info("Note: The newContext argument is deprecated in 0.8.0. Values passed to this option will be ignored");
    }


    if (argv.mobileDevice) {
      argv.emulateDevice = devices[argv.mobileDevice.replace("-", " ")];
      if (!argv.emulateDevice) {
        logger.fatal("Unknown device: " + argv.mobileDevice);
      }
    } else {
      argv.emulateDevice = {viewport: null};
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

    if (argv.netIdleWait === -1) {
      if (argv.scopeType === "page" || argv.scopeType === "page-spa") {
        argv.netIdleWait = 15;
      } else {
        argv.netIdleWait = 2;
      }
      //logger.debug(`Set netIdleWait to ${argv.netIdleWait} seconds`);
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

    if ((argv.diskUtilization < 0 || argv.diskUtilization > 99)) {
      argv.diskUtilization = 90;
    }

    return true;
  }
}

export function parseArgs(argv) {
  return new ArgParser().parseArgs(argv);
}
