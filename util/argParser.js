const yaml = require("js-yaml");
const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const { NewWindowPage} = require("./screencaster");
const { constants } = require("./constants");

// ============================================================================
class argParser {
  constructor(){
    this.constants = new constants();
  }

  parseYaml(yamlConfigFile){
    try {
      console.log("YAML config detected. The values declared in this file will be used and any command line flags passed will override them");

      var fileContents = fs.readFileSync(yamlConfigFile, "utf8");

      var data = yaml.safeLoad(fileContents);

      if (!data.crawler){
        console.log("Error parsing the yaml file: Yaml config file needs to have the arguments under 'crawler' field please see the github readme for more details on the yaml configuration");
        return false;
      }

      this.validateArgs(data.crawler);
      return data.crawler;
    }
    catch (e) {
      console.log(e);
      return false;
    }
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
      if (!this.constants.WAIT_UNTIL_OPTS.includes(opt)) {
        throw new Error("Invalid waitUntil option, must be one of: " + this.constants.WAIT_UNTIL_OPTS.join(","));
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
      behaviorOpts.log = this.constants.BEHAVIOR_LOG_FUNC;
    } else if (argv.logging.includes("behaviors-debug")) {
      behaviorOpts.log = this.constants.BEHAVIOR_LOG_FUNC;
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

module.exports.argParser = argParser;
