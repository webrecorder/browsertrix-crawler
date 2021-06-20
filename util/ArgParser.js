const yaml = require("js-yaml");
const puppeteer = require("puppeteer-core");
const { Cluster } = require("puppeteer-cluster");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const { NewWindowPage} = require("./ScreenCaster");
const { constants } = require("./constants");

// ============================================================================
class ArgParser {
  constructor(){
    this.constants = new constants();
  }

  parseYaml(yamlConfigFile){
    try {
      console.log(`YAML config detected. File path is ${yamlConfigFile}. The values declared in this file will be used and any command line flags passed will override them`);
      var fileContents = fs.readFileSync(yamlConfigFile, "utf8");
      var data = yaml.safeLoad(fileContents);

      if (!data.crawler){
        console.log("Error parsing the yaml file: Yaml config file needs to have the arguments under 'crawler' field please see the github readme for more details on the yaml configuration");
        return false;
      }
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


  validateArgs(parsedArgs, commandLineArgs) {
    let purl;

    if (parsedArgs.yamlConfig){
      if (fs.existsSync(parsedArgs.yamlConfig)){
        var parsedYamlArgs = this.parseYaml(parsedArgs.yamlConfig);
        for (const property in parsedYamlArgs) {
          if (!(property in commandLineArgs)){
            parsedArgs[property] = parsedYamlArgs[property];
          }
        }
      }
      else{
        console.log(`A yaml file ${parsedArgs.yamlConfig} was passed but does not exist`);
      }
    }

    if (parsedArgs.url) {
      // Scope for crawl, default to the domain of the URL
      // ensure valid url is used (adds trailing slash if missing)
      //parsedArgs.seeds = [Crawler.validateUserUrl(parsedArgs.url)];
      purl = this.validateUserUrl(parsedArgs.url);
      parsedArgs.url = purl.href;
    }

    if (parsedArgs.url && parsedArgs.urlFile) {
      console.warn("You've passed a urlFile param, only urls listed in that file will be processed. If you also passed a url to the --url flag that will be ignored.");
    }

    // Check that the collection name is valid.
    if (parsedArgs.collection.search(/^[\w][\w-]*$/) === -1){
      throw new Error(`\n${parsedArgs.collection} is an invalid collection name. Please supply a collection name only using alphanumeric characters and the following characters [_ - ]\n`);
    }

    parsedArgs.timeout *= 1000;

    // waitUntil condition must be: load, domcontentloaded, networkidle0, networkidle2
    // can be multiple separate by comma
    // (see: https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options)
    if (typeof parsedArgs.waitUntil != "object"){
      parsedArgs.waitUntil = parsedArgs.waitUntil.split(",");
    }

    for (const opt of parsedArgs.waitUntil) {
      if (!this.constants.WAIT_UNTIL_OPTS.includes(opt)) {
        throw new Error("Invalid waitUntil option, must be one of: " + this.constants.WAIT_UNTIL_OPTS.join(","));
      }
    }

    // log options
    parsedArgs.logging = parsedArgs.logging.split(",");

    // background behaviors to apply
    const behaviorOpts = {};
    if (typeof parsedArgs.behaviors != "object"){
      parsedArgs.behaviors = parsedArgs.behaviors.split(",");
    }
    parsedArgs.behaviors.forEach((x) => behaviorOpts[x] = true);
    if (parsedArgs.logging.includes("behaviors")) {
      behaviorOpts.log = this.constants.BEHAVIOR_LOG_FUNC;
    } else if (parsedArgs.logging.includes("behaviors-debug")) {
      behaviorOpts.log = this.constants.BEHAVIOR_LOG_FUNC;
      this.behaviorsLogDebug = true;
    }
    this.behaviorOpts = JSON.stringify(behaviorOpts);

    if (!parsedArgs.newContext) {
      parsedArgs.newContext = "page";
    }

    switch (parsedArgs.newContext) {
    case "page":
      parsedArgs.newContext = Cluster.CONCURRENCY_PAGE;
      if (parsedArgs.screencastPort && parsedArgs.workers > 1) {
        console.warn("Note: Screencast with >1 workers and default page context may only show one page at a time. To fix, add '--newContext window' to open each page in a new window");
      }
      break;

    case "session":
      parsedArgs.newContext = Cluster.CONCURRENCY_CONTEXT;
      break;

    case "browser":
      parsedArgs.newContext = Cluster.CONCURRENCY_BROWSER;
      break;

    case "window":
      parsedArgs.newContext = NewWindowPage;
      break;

    default:
      throw new Error("Invalid newContext, must be one of: page, session, browser");
    }

    if (parsedArgs.mobileDevice) {
      this.emulateDevice = puppeteer.devices[parsedArgs.mobileDevice];
      if (!this.emulateDevice) {
        throw new Error("Unknown device: " + parsedArgs.mobileDevice);
      }
    }

    if (parsedArgs.useSitemap === true) {
      const url = new URL(parsedArgs.url);
      url.pathname = "/sitemap.xml";
      parsedArgs.useSitemap = url.href;
    }

    // Support one or multiple exclude
    if (parsedArgs.exclude) {
      if (typeof(parsedArgs.exclude) === "string") {
        parsedArgs.exclude = [new RegExp(parsedArgs.exclude)];
      } else {
        parsedArgs.exclude = parsedArgs.exclude.map(e => new RegExp(e));
      }
    }
    else {
      parsedArgs.exclude = [];
    }

    // warn if both scope and scopeType are set
    if (parsedArgs.scope && parsedArgs.scopeType) {
      console.warn("You've specified a --scopeType and a --scope regex. The custom scope regex will take precedence, overriding the scopeType");
    }

    // Support one or multiple scopes set directly, or via scopeType
    if (parsedArgs.scope) {
      if (typeof(parsedArgs.scope) === "string") {
        parsedArgs.scope = [new RegExp(parsedArgs.scope)];
      } else {
        parsedArgs.scope = parsedArgs.scope.map(e => new RegExp(e));
      }
    } else {

      // Set scope via scopeType
      if (!parsedArgs.scopeType) {
        parsedArgs.scopeType = parsedArgs.urlFile ? "any" : "prefix";
      }

      if (parsedArgs.scopeType && parsedArgs.url) {
        switch (parsedArgs.scopeType) {
        case "page":
          // allow scheme-agnostic URLS as likely redirects
          parsedArgs.scope = [new RegExp("^" + this.rxEscape(parsedArgs.url).replace(purl.protocol, "https?:") + "#.+")];
          parsedArgs.allowHashUrls = true;
          break;

        case "prefix":
          parsedArgs.scope = [new RegExp("^" + this.rxEscape(parsedArgs.url.slice(0, parsedArgs.url.lastIndexOf("/") + 1)))];
          break;

        case "domain":
          parsedArgs.scope = [new RegExp("^" + this.rxEscape(purl.origin + "/"))];
          break;

        case "any":
          parsedArgs.scope = [];
          break;

        default:
          throw new Error(`Invalid scope type "${parsedArgs.scopeType}" specified, valid types are: page, prefix, domain`);


        }
      }
    }

    // Resolve statsFilename
    if (parsedArgs.statsFilename) {
      parsedArgs.statsFilename = path.resolve(parsedArgs.cwd, parsedArgs.statsFilename);
    }

    if (parsedArgs.profile) {
      child_process.execSync("tar xvfz " + parsedArgs.profile, {cwd: this.profileDir});
    }

    return true;
  }
}

module.exports.ArgParser = ArgParser;
