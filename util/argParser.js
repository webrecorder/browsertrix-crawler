const yaml = require("js-yaml");
const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const { NewWindowPage} = require("./screencaster");
const { BEHAVIOR_LOG_FUNC, WAIT_UNTIL_OPTS } = require("./constants");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// ============================================================================
class ArgParser {
  get cliOpts() {
    return {
      "url": {
        alias: "u",
        describe: "The URL to start crawling from",
        type: "string",
      },

      "seeds": {
        describe: "The URL to start crawling from",
        type: "array",
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
        describe: "Simplified scope for which URLs to crawl, can be: prefix, page, domain, any",
        type: "string",
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
 
  rxEscape(string) {
    return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  }


  validateUserUrl(url) {
    url = new URL(url);
    if (url.protocol !== "http:" && url.protocol != "https:") {
      throw new Error("URL must start with http:// or https://");
    }

    return url;
  }

  validateArgs(argv) {
    let purl;
    if (argv.url) {
      // Scope for crawl, default to the domain of the URL
      // ensure valid url is used (adds trailing slash if missing)
      //argv.seeds = [Crawler.validateUserUrl(argv.url)];
      purl = this.validateUserUrl(argv.url);
      argv.url = purl.href;
    }

    if (argv.url && argv.urlFile) {
      console.warn("You've passed a urlFile param, only urls listed in that file will be processed. If you also passed a url to the --url flag that will be ignored.");
    }

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
    }
    else {
      argv.exclude = [];
    }

    // warn if both scope and scopeType are set
    if (argv.scope && argv.scopeType) {
      console.warn("You've specified a --scopeType and a --scope regex. The custom scope regex will take precedence, overriding the scopeType");
    }

    // Support one or multiple scopes set directly, or via scopeType
    if (argv.scope) {
      if (typeof(argv.scope) === "string") {
        argv.scope = [new RegExp(argv.scope)];
      } else {
        argv.scope = argv.scope.map(e => new RegExp(e));
      }
    } else {

      // Set scope via scopeType
      if (!argv.scopeType) {
        argv.scopeType = argv.urlFile ? "any" : "prefix";
      }

      if (argv.scopeType && argv.url) {
        switch (argv.scopeType) {
        case "page":
          // allow scheme-agnostic URLS as likely redirects
          argv.scope = [new RegExp("^" + this.rxEscape(argv.url).replace(purl.protocol, "https?:") + "#.+")];
          argv.allowHashUrls = true;
          break;

        case "prefix":
          argv.scope = [new RegExp("^" + this.rxEscape(argv.url.slice(0, argv.url.lastIndexOf("/") + 1)))];
          break;

        case "domain":
          argv.scope = [new RegExp("^" + this.rxEscape(purl.origin + "/"))];
          break;

        case "any":
          argv.scope = [];
          break;

        default:
          throw new Error(`Invalid scope type "${argv.scopeType}" specified, valid types are: page, prefix, domain`);
        }
      } else if (!argv.scope) {
        argv.scope = [];
      }
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
