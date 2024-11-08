import path from "path";
import fs from "fs";
import os from "os";

import yaml from "js-yaml";
import { KnownDevices as devices } from "puppeteer-core";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createParser } from "css-selector-parser";

import {
  BEHAVIOR_LOG_FUNC,
  WAIT_UNTIL_OPTS,
  EXTRACT_TEXT_TYPES,
  SERVICE_WORKER_OPTS,
  DEFAULT_SELECTORS,
  ExtractSelector,
} from "./constants.js";
import { ScopedSeed } from "./seeds.js";
import { interpolateFilename } from "./storage.js";
import { screenshotTypes } from "./screenshots.js";
import {
  DEFAULT_EXCLUDE_LOG_CONTEXTS,
  LOG_CONTEXT_TYPES,
  LogContext,
  logger,
} from "./logger.js";
import { SaveState } from "./state.js";

// ============================================================================
export type CrawlerArgs = ReturnType<typeof parseArgs> & {
  logContext: LogContext[];
  logExcludeContext: LogContext[];
  text: string[];

  scopedSeeds: ScopedSeed[];

  selectLinks: ExtractSelector[];

  crawlId: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  origConfig: Record<string, any>;
  state?: SaveState;

  warcInfo?: Record<string, string>;
};

// ============================================================================
class ArgParser {
  initArgs(argv: string[]) {
    const coerce = (array: string[]): string[] => {
      return array.flatMap((v) => v.split(",")).filter((x) => !!x);
    };

    return yargs(hideBin(argv))
      .usage("crawler [options]")
      .options({
        seeds: {
          alias: "url",
          describe: "The URL to start crawling from",
          type: "array",
          default: [],
        },

        seedFile: {
          alias: ["urlFile"],
          describe:
            "If set, read a list of seed urls, one per line, from the specified",
          type: "string",
        },

        workers: {
          alias: "w",
          describe: "The number of workers to run in parallel",
          default: 1,
          type: "number",
        },

        crawlId: {
          alias: "id",
          describe:
            "A user provided ID for this crawl or crawl configuration (can also be set via CRAWL_ID env var, defaults to hostname)",
          type: "string",
        },

        waitUntil: {
          describe:
            "Puppeteer page.goto() condition to wait for before continuing, can be multiple separated by ','",
          type: "array",
          default: ["load", "networkidle2"],
          choices: WAIT_UNTIL_OPTS,
          coerce,
        },

        depth: {
          describe: "The depth of the crawl for all seeds",
          default: -1,
          type: "number",
        },

        extraHops: {
          describe:
            "Number of extra 'hops' to follow, beyond the current scope",
          default: 0,
          type: "number",
        },

        pageLimit: {
          alias: "limit",
          describe: "Limit crawl to this number of pages",
          default: 0,
          type: "number",
        },

        maxPageLimit: {
          describe:
            "Maximum pages to crawl, overriding  pageLimit if both are set",
          default: 0,
          type: "number",
        },

        pageLoadTimeout: {
          alias: "timeout",
          describe: "Timeout for each page to load (in seconds)",
          default: 90,
          type: "number",
        },

        scopeType: {
          describe:
            "A predefined scope of the crawl. For more customization, use 'custom' and set scopeIncludeRx regexes",
          type: "string",
          choices: [
            "page",
            "page-spa",
            "prefix",
            "host",
            "domain",
            "any",
            "custom",
          ],
        },

        scopeIncludeRx: {
          alias: "include",
          describe:
            "Regex of page URLs that should be included in the crawl (defaults to the immediate directory of URL)",
          type: "string",
        },

        scopeExcludeRx: {
          alias: "exclude",
          describe:
            "Regex of page URLs that should be excluded from the crawl.",
          type: "string",
        },

        allowHashUrls: {
          describe:
            "Allow Hashtag URLs, useful for single-page-application crawling or when different hashtags load dynamic content",
        },

        selectLinks: {
          describe:
            "One or more selectors for extracting links, in the format [css selector]->[property to use],[css selector]->@[attribute to use]",
          type: "array",
          default: ["a[href]->href"],
          coerce,
        },

        blockRules: {
          describe:
            "Additional rules for blocking certain URLs from being loaded, by URL regex and optionally via text match in an iframe",
          type: "array",
          default: [],
        },

        blockMessage: {
          describe:
            "If specified, when a URL is blocked, a record with this error message is added instead",
          type: "string",
          default: "",
        },

        blockAds: {
          alias: "blockads",
          describe:
            "If set, block advertisements from being loaded (based on Stephen Black's blocklist)",
          type: "boolean",
          default: false,
        },

        adBlockMessage: {
          describe:
            "If specified, when an ad is blocked, a record with this error message is added instead",
          type: "string",
          default: "",
        },

        collection: {
          alias: "c",
          describe:
            "Collection name to crawl to (replay will be accessible under this name in pywb preview)",
          type: "string",
          default: "crawl-@ts",
        },

        headless: {
          describe: "Run in headless mode, otherwise start xvfb",
          type: "boolean",
          default: false,
        },

        driver: {
          describe: "Custom driver for the crawler, if any",
          type: "string",
        },

        generateCDX: {
          alias: ["generatecdx", "generateCdx"],
          describe:
            "If set, generate index (CDXJ) for use with pywb after crawl is done",
          type: "boolean",
          default: false,
        },

        combineWARC: {
          alias: ["combinewarc", "combineWarc"],
          describe: "If set, combine the warcs",
          type: "boolean",
          default: false,
        },

        rolloverSize: {
          describe: "If set, declare the rollover size",
          default: 1000000000,
          type: "number",
        },

        generateWACZ: {
          alias: ["generatewacz", "generateWacz"],
          describe: "If set, generate WACZ on disk",
          type: "boolean",
          default: false,
        },

        logging: {
          describe:
            "Logging options for crawler, can include: stats (enabled by default), jserrors, debug",
          type: "array",
          default: ["stats"],
          coerce,
        },

        logLevel: {
          describe: "Comma-separated list of log levels to include in logs",
          type: "array",
          default: [],
          coerce,
        },

        context: {
          alias: "logContext",
          describe: "Comma-separated list of contexts to include in logs",
          type: "array",
          default: [],
          choices: LOG_CONTEXT_TYPES,
          coerce,
        },

        logExcludeContext: {
          describe: "Comma-separated list of contexts to NOT include in logs",
          type: "array",
          default: DEFAULT_EXCLUDE_LOG_CONTEXTS,
          choices: LOG_CONTEXT_TYPES,
          coerce,
        },

        text: {
          describe:
            "Extract initial (default) or final text to pages.jsonl or WARC resource record(s)",
          type: "array",
          choices: EXTRACT_TEXT_TYPES,
          coerce: (array) => {
            // backwards compatibility: default --text true / --text -> --text to-pages
            if (!array.length || (array.length === 1 && array[0] === "true")) {
              return ["to-pages"];
            }
            if (array.length === 1 && array[0] === "false") {
              return [];
            }
            return coerce(array);
          },
        },

        cwd: {
          describe:
            "Crawl working directory for captures (pywb root). If not set, defaults to process.cwd()",
          type: "string",
          default: process.cwd(),
        },

        mobileDevice: {
          describe:
            "Emulate mobile device by name from: https://github.com/puppeteer/puppeteer/blob/main/src/common/DeviceDescriptors.ts",
          type: "string",
        },

        userAgent: {
          describe: "Override user-agent with specified string",
          type: "string",
        },

        userAgentSuffix: {
          describe:
            "Append suffix to existing browser user-agent (ex: +MyCrawler, info@example.com)",
          type: "string",
        },

        useSitemap: {
          alias: "sitemap",
          describe:
            "If enabled, check for sitemaps at /sitemap.xml, or custom URL if URL is specified",
        },

        sitemapFromDate: {
          alias: "sitemapFrom",
          describe:
            "If set, filter URLs from sitemaps to those greater than or equal to (>=) provided ISO Date string (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS or partial date)",
          type: "string",
        },

        sitemapToDate: {
          alias: "sitemapTo",
          describe:
            "If set, filter URLs from sitemaps to those less than or equal to (<=) provided ISO Date string (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS or partial date)",
          type: "string",
        },

        statsFilename: {
          type: "string",
          describe:
            "If set, output stats as JSON to this file. (Relative filename resolves to crawl working directory)",
        },

        behaviors: {
          describe: "Which background behaviors to enable on each page",
          type: "array",
          default: ["autoplay", "autofetch", "autoscroll", "siteSpecific"],
          choices: ["autoplay", "autofetch", "autoscroll", "siteSpecific"],
          coerce,
        },

        behaviorTimeout: {
          describe:
            "If >0, timeout (in seconds) for in-page behavior will run on each page. If 0, a behavior can run until finish.",
          default: 90,
          type: "number",
        },

        postLoadDelay: {
          describe:
            "If >0, amount of time to sleep (in seconds) after page has loaded, before taking screenshots / getting text / running behaviors",
          default: 0,
          type: "number",
        },

        pageExtraDelay: {
          alias: "delay",
          describe:
            "If >0, amount of time to sleep (in seconds) after behaviors before moving on to next page",
          default: 0,
          type: "number",
        },

        dedupPolicy: {
          describe: "Deduplication policy",
          default: "skip",
          type: "string",
          choices: ["skip", "revisit", "keep"],
        },

        profile: {
          describe:
            "Path or HTTP(S) URL to tar.gz file which contains the browser profile directory",
          type: "string",
        },

        screenshot: {
          describe:
            "Screenshot options for crawler, can include: view, thumbnail, fullPage",
          type: "array",
          default: [],
          choices: Array.from(Object.keys(screenshotTypes)),
          coerce,
        },

        screencastPort: {
          describe:
            "If set to a non-zero value, starts an HTTP server with screencast accessible on this port",
          type: "number",
          default: 0,
        },

        screencastRedis: {
          describe:
            "If set, will use the state store redis pubsub for screencasting. Requires --redisStoreUrl to be set",
          type: "boolean",
          default: false,
        },

        warcInfo: {
          alias: ["warcinfo"],
          describe:
            "Optional fields added to the warcinfo record in combined WARCs",
          //type: "object"
        },

        redisStoreUrl: {
          describe:
            "If set, url for remote redis server to store state. Otherwise, using local redis instance",
          type: "string",
          default: "redis://localhost:6379/0",
        },

        saveState: {
          describe:
            "If the crawl state should be serialized to the crawls/ directory. Defaults to 'partial', only saved when crawl is interrupted",
          type: "string",
          default: "partial",
          choices: ["never", "partial", "always"],
        },

        saveStateInterval: {
          describe:
            "If save state is set to 'always', also save state during the crawl at this interval (in seconds)",
          type: "number",
          default: 300,
        },

        saveStateHistory: {
          describe:
            "Number of save states to keep during the duration of a crawl",
          type: "number",
          default: 5,
        },

        sizeLimit: {
          describe:
            "If set, save state and exit if size limit exceeds this value",
          type: "number",
          default: 0,
        },

        diskUtilization: {
          describe:
            "If set, save state and exit if disk utilization exceeds this percentage value",
          type: "number",
          default: 90,
        },

        timeLimit: {
          describe: "If set, save state and exit after time limit, in seconds",
          type: "number",
          default: 0,
        },

        healthCheckPort: {
          describe: "port to run healthcheck on",
          type: "number",
          default: 0,
        },

        overwrite: {
          describe:
            "overwrite current crawl data: if set, existing collection directory will be deleted before crawl is started",
          type: "boolean",
          default: false,
        },

        waitOnDone: {
          describe:
            "if set, wait for interrupt signal when finished instead of exiting",
          type: "boolean",
          default: false,
        },

        restartsOnError: {
          describe:
            "if set, assume will be restarted if interrupted, don't run post-crawl processes on interrupt",
          type: "boolean",
          default: false,
        },

        netIdleWait: {
          describe:
            "if set, wait for network idle after page load and after behaviors are done (in seconds). if -1 (default), determine based on scope",
          type: "number",
          default: -1,
        },

        lang: {
          describe:
            "if set, sets the language used by the browser, should be ISO 639 language[-country] code",
          type: "string",
        },

        title: {
          describe:
            "If set, write supplied title into WACZ datapackage.json metadata",
          type: "string",
        },

        description: {
          alias: ["desc"],
          describe:
            "If set, write supplied description into WACZ datapackage.json metadata",
          type: "string",
        },

        originOverride: {
          describe:
            "if set, will redirect requests from each origin in key to origin in the value, eg. --originOverride https://host:port=http://alt-host:alt-port",
          type: "array",
          default: [],
        },

        logErrorsToRedis: {
          describe: "If set, write error messages to redis",
          type: "boolean",
          default: false,
        },

        writePagesToRedis: {
          describe: "If set, write page objects to redis",
          type: "boolean",
          default: false,
        },

        failOnFailedSeed: {
          describe:
            "If set, crawler will fail with exit code 1 if any seed fails. When combined with --failOnInvalidStatus," +
            "will result in crawl failing with exit code 1 if any seed has a 4xx/5xx response",
          type: "boolean",
          default: false,
        },

        failOnFailedLimit: {
          describe:
            "If set, save state and exit if number of failed pages exceeds this value",
          type: "number",
          default: 0,
        },

        failOnInvalidStatus: {
          describe:
            "If set, will treat pages with 4xx or 5xx response as failures. When combined with --failOnFailedLimit" +
            " or --failOnFailedSeed may result in crawl failing due to non-200 responses",
          type: "boolean",
          default: false,
        },

        customBehaviors: {
          describe:
            "Custom behavior files to inject. Valid values: URL to file, path to file, path to directory" +
            " of behaviors, URL to Git repo of behaviors (prefixed with git+, optionally specify branch and" +
            " relative path to a directory within repo as branch and path query parameters, e.g." +
            ' --customBehaviors "git+https://git.example.com/repo.git?branch=dev&path=some/dir"',
          type: "array",
          default: [],
        },

        debugAccessRedis: {
          describe:
            "if set, runs internal redis without protected mode to allow external access (for debugging)",
          type: "boolean",
        },

        debugAccessBrowser: {
          describe: "if set, allow debugging browser on port 9222 via CDP",
          type: "boolean",
        },

        warcPrefix: {
          describe:
            "prefix for WARC files generated, including WARCs added to WACZ",
          type: "string",
        },

        serviceWorker: {
          alias: "sw",
          describe:
            "service worker handling: disabled, enabled, or disabled with custom profile",
          choices: SERVICE_WORKER_OPTS,
          default: "disabled",
        },

        proxyServer: {
          describe:
            "if set, will use specified proxy server. Takes precedence over any env var proxy settings",
          type: "string",
        },

        dryRun: {
          describe:
            "If true, no archive data is written to disk, only pages and logs (and optionally saved state).",
          type: "boolean",
        },

        qaSource: {
          describe: "Required for QA mode. Source (WACZ or multi WACZ) for QA",
          type: "string",
        },

        qaDebugImageDiff: {
          describe:
            "if specified, will write crawl.png, replay.png and diff.png for each page where they're different",
          type: "boolean",
        },

        sshProxyPrivateKeyFile: {
          describe:
            "path to SSH private key for SOCKS5 over SSH proxy connection",
          type: "string",
        },

        sshProxyKnownHostsFile: {
          describe:
            "path to SSH known hosts file for SOCKS5 over SSH proxy connection",
          type: "string",
        },
      });
  }

  parseArgs(argvParams?: string[], isQA = false) {
    let argv = argvParams || process.argv;

    const envArgs =
      isQA && process.env.QA_ARGS
        ? process.env.QA_ARGS
        : process.env.CRAWL_ARGS;

    if (envArgs) {
      argv = argv.concat(this.splitCrawlArgsQuoteSafe(envArgs));
    }

    let origConfig = {};

    const parsed = this.initArgs(argv)
      .config(
        "config",
        "Path to YAML config file",
        (configPath: string | number) => {
          if (configPath === "/crawls/stdin") {
            configPath = process.stdin.fd;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          origConfig = yaml.load(fs.readFileSync(configPath, "utf8")) as any;
          return origConfig;
        },
      )
      .check((argv) => this.validateArgs(argv, isQA))
      .parseSync();

    parsed.origConfig = origConfig;

    return parsed;
  }

  splitCrawlArgsQuoteSafe(crawlArgs: string): string[] {
    // Split process.env.CRAWL_ARGS on spaces but retaining spaces within double quotes
    const regex = /"[^"]+"|[^\s]+/g;
    const res = crawlArgs.match(regex);
    return res ? res.map((e) => e.replace(/"(.+)"/, "$1")) : [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validateArgs(argv: any, isQA: boolean) {
    argv.crawlId = argv.crawlId || process.env.CRAWL_ID || os.hostname();
    argv.collection = interpolateFilename(argv.collection, argv.crawlId);

    // Check that the collection name is valid.
    if (argv.collection.search(/^[\w][\w-]*$/) === -1) {
      logger.fatal(
        `\n${argv.collection} is an invalid collection name. Please supply a collection name only using alphanumeric characters and the following characters [_ - ]\n`,
      );
    }

    // background behaviors to apply
    const behaviorOpts: { [key: string]: string | boolean } = {};
    if (argv.behaviors.length > 0) {
      argv.behaviors.forEach((x: string) => (behaviorOpts[x] = true));
      behaviorOpts.log = BEHAVIOR_LOG_FUNC;
      behaviorOpts.startEarly = true;
      argv.behaviorOpts = JSON.stringify(behaviorOpts);
    } else {
      argv.behaviorOpts = "";
    }

    argv.text = argv.text || [];

    if (argv.mobileDevice) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      argv.emulateDevice = (devices as Record<string, any>)[
        argv.mobileDevice.replace("-", " ")
      ];
      if (!argv.emulateDevice) {
        logger.fatal("Unknown device: " + argv.mobileDevice);
      }
    } else {
      argv.emulateDevice = { viewport: null };
    }

    if (argv.seedFile) {
      const urlSeedFile = fs.readFileSync(argv.seedFile, "utf8");
      const urlSeedFileList = urlSeedFile.split("\n");

      if (typeof argv.seeds === "string") {
        argv.seeds = [argv.seeds];
      }

      for (const seed of urlSeedFileList) {
        if (seed) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (argv.seeds as any).push(seed);
        }
      }
    }

    let selectLinks: ExtractSelector[];

    const parser = createParser();

    if (argv.selectLinks) {
      selectLinks = argv.selectLinks.map((x: string) => {
        const parts = x.split("->");
        const selector = parts[0];
        const value = parts[1] || "";
        const extract = parts.length > 1 ? value.replace("@", "") : "href";
        const isAttribute = value.startsWith("@");
        try {
          parser(selector);
        } catch (e) {
          logger.fatal("Invalid Link Extraction CSS Selector", { selector });
        }
        return { selector, extract, isAttribute };
      });
    } else {
      selectLinks = DEFAULT_SELECTORS;
    }

    argv.selectLinks = selectLinks;

    if (argv.netIdleWait === -1) {
      if (argv.scopeType === "page" || argv.scopeType === "page-spa") {
        argv.netIdleWait = 15;
      } else {
        argv.netIdleWait = 2;
      }
      //logger.debug(`Set netIdleWait to ${argv.netIdleWait} seconds`);
    }

    const scopedSeeds: ScopedSeed[] = [];

    if (!isQA) {
      const scopeOpts = {
        scopeType: argv.scopeType,
        sitemap: argv.sitemap,
        include: argv.include,
        exclude: argv.exclude,
        depth: argv.depth,
        extraHops: argv.extraHops,
      };

      for (const seed of argv.seeds) {
        const newSeed = typeof seed === "string" ? { url: seed } : seed;

        try {
          scopedSeeds.push(new ScopedSeed({ ...scopeOpts, ...newSeed }));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          logger.error("Failed to create seed", {
            error: e.toString(),
            ...scopeOpts,
            ...newSeed,
          });
          if (argv.failOnFailedSeed) {
            logger.fatal(
              "Invalid seed specified, aborting crawl",
              { url: newSeed.url },
              "general",
              1,
            );
          }
        }
      }

      if (!scopedSeeds.length) {
        logger.fatal("No valid seeds specified, aborting crawl");
      }
    } else if (!argv.qaSource) {
      logger.fatal("--qaSource required for QA mode");
    }

    argv.scopedSeeds = scopedSeeds;

    // Resolve statsFilename
    if (argv.statsFilename) {
      argv.statsFilename = path.resolve(argv.cwd, argv.statsFilename);
    }

    if (argv.diskUtilization < 0 || argv.diskUtilization > 99) {
      argv.diskUtilization = 90;
    }

    return true;
  }
}

export function parseArgs(argv?: string[], isQA = false) {
  return new ArgParser().parseArgs(argv, isQA);
}
