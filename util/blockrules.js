import fs from "fs";

import { Logger } from "./logger.js";

const logger = new Logger();

const RULE_TYPES = ["block", "allowOnly"];

const ALWAYS_ALLOW = ["https://pywb.proxy/", "http://pywb.proxy/"];

const BlockState = {
  ALLOW: null,
  BLOCK_PAGE_NAV: "page",
  BLOCK_IFRAME_NAV: "iframe",
  BLOCK_OTHER: "resource",
  BLOCK_AD: "advertisement"
};


// ===========================================================================
class BlockRule
{
  constructor(data) {
    if (typeof(data) === "string") {
      this.url = new RegExp(data);
      this.type = "block";
    } else {
      this.url = data.url ? new RegExp(data.url) : null;
      this.frameTextMatch = data.frameTextMatch ? new RegExp(data.frameTextMatch) : null;
      this.inFrameUrl = data.inFrameUrl ? new RegExp(data.inFrameUrl) : null;
      this.type = data.type || "block";
    }

    if (!RULE_TYPES.includes(this.type)) {
      logger.fatal("Rule \"type\" must be: " + RULE_TYPES.join(", "));
    }
  }

  toString() {
    return `\
* Rule for URL Regex: ${this.url}
    Type: ${this.type}
    In Frame Regex: ${this.inFrameUrl ? this.inFrameUrl : "any"}
    Resource Type: ${this.frameTextMatch ? "frame" : "any"}
${this.frameTextMatch ? "Frame Text Regex: " + this.frameTextMatch : ""}
`;
  }
}


// ===========================================================================
export class BlockRules
{
  constructor(blockRules, blockPutUrl, blockErrMsg, logger) {
    this.rules = [];
    this.blockPutUrl = blockPutUrl;
    this.blockErrMsg = blockErrMsg;
    this.logger = logger;

    this.blockedUrlSet = new Set();

    for (const ruleData of blockRules) {
      this.rules.push(new BlockRule(ruleData));
    }

    if (this.rules.length) {
      this.logger.debug("URL Block Rules:\n", {}, "blocking");
      for (const rule of this.rules) {
        this.logger.debug(rule.toString(), {}, "blocking");
      }
    }
  }

  async initPage(page) {
    if (!this.rules.length) {
      return;
    }

    if (page._btrix_interceptionAdded) {
      return true;
    }

    page._btrix_interceptionAdded = true;

    await page.setRequestInterception(true);

    const logDetails = {page: page.url()};

    page.on("request", async (request) => {
      try {
        await this.handleRequest(request, logDetails);
      } catch (e) {
        this.logger.warn("Error handling request", {...logDetails, ...e}, "blocking");
      }
    });
  }

  async handleRequest(request, logDetails) {
    const url = request.url();

    let blockState;

    try {
      blockState = await this.shouldBlock(request, url, logDetails);

      if (blockState === BlockState.ALLOW) {
        await request.continue();
      } else {
        await request.abort("blockedbyclient");
      }

    } catch (e) {
      this.logger.debug(`Block: (${blockState}) Failed On: ${url}`, {...logDetails, ...e}, "blocking");
    }
  }

  async shouldBlock(request, url, logDetails) {
    if (!url.startsWith("http:") && !url.startsWith("https:")) {
      return BlockState.ALLOW;
    }

    const isNavReq = request.isNavigationRequest();

    const frame = request.frame();

    let frameUrl = "";
    let blockState;

    if (isNavReq) {
      const parentFrame = frame.parentFrame();
      if (parentFrame) {
        frameUrl = parentFrame.url();
        blockState = BlockState.BLOCK_IFRAME_NAV;
      } else {
        frameUrl = frame.url();
        blockState = BlockState.BLOCK_PAGE_NAV;
      }
    } else {
      frameUrl = frame ? frame.url() : "";
      blockState = BlockState.BLOCK_OTHER;
    }

    // ignore initial page
    if (frameUrl === "about:blank") {
      return BlockState.ALLOW;
    }

    // always allow special pywb proxy script
    for (const allowUrl of ALWAYS_ALLOW) {
      if (url.startsWith(allowUrl)) {
        return BlockState.ALLOW;
      }
    }

    for (const rule of this.rules) {
      const {done, block} = await this.ruleCheck(rule, request, url, frameUrl, isNavReq, logDetails);

      if (block) {
        if (blockState === BlockState.BLOCK_PAGE_NAV) {
          this.logger.warn("Block rule match for page request ignored, set --exclude to block full pages", {...logDetails, url}, "blocking");
          return BlockState.ALLOW;
        }
        this.logger.debug("URL Blocked in iframe", {...logDetails, url, frameUrl}, "blocking");
        await this.recordBlockMsg(url);
        return blockState;
      }
      if (done) {
        break;
      }
    }

    return BlockState.ALLOW;
  }

  async ruleCheck(rule, request, reqUrl, frameUrl, isNavReq, logDetails) {
    const {url, inFrameUrl, frameTextMatch} = rule;

    const type = rule.type || "block";
    const allowOnly = (type === "allowOnly");

    // not a frame match, skip rule
    if (inFrameUrl && !frameUrl.match(inFrameUrl)) {
      return {block: false, done: false};
    }

    const urlMatched = (url && reqUrl.match(url));

    // if frame text-based rule: if url matched and a frame request
    // frame text-based match: only applies to nav requests, never block otherwise
    if (frameTextMatch) {
      if (!urlMatched || !isNavReq) {
        return {block: false, done: false};
      }

      const block = await this.isTextMatch(request, reqUrl, frameTextMatch, logDetails) ? !allowOnly : allowOnly;
      this.logger.debug("URL Conditional rule in iframe",  {...logDetails, url, rule: block ? "BLOCKED" : "ALLOWED", frameUrl}, "blocking");
      return {block, done: true};
    }

    // for non frame text rule, simply match by URL
    const block = urlMatched ? !allowOnly : allowOnly;
    return {block, done: false};
  }

  async isTextMatch(request, reqUrl, frameTextMatch, logDetails) {
    try {
      const res = await fetch(reqUrl);
      const text = await res.text();

      return !!text.match(frameTextMatch);

    } catch (e) {
      this.logger.debug("Error determining text match", {...logDetails, ...e}, "blocking");
    }
  }

  async recordBlockMsg(url) {
    if (this.blockedUrlSet.has(url)) {
      return;
    }

    this.blockedUrlSet.add(url);

    if (!this.blockErrMsg || !this.blockPutUrl) {
      return;
    }

    const body = this.blockErrMsg;
    const putUrl = new URL(this.blockPutUrl);
    putUrl.searchParams.set("url", url);
    await fetch(putUrl.href, {method: "PUT", headers: {"Content-Type": "text/html"}, body});
  }
}


// ===========================================================================
export class AdBlockRules extends BlockRules
{
  constructor(blockPutUrl, blockErrMsg, logger, adhostsFilePath = "../ad-hosts.json") {
    super([], blockPutUrl, blockErrMsg, logger);
    this.adhosts = JSON.parse(fs.readFileSync(new URL(adhostsFilePath, import.meta.url)));
  }

  async initPage(page) {
    if (page._btrix_adInterceptionAdded) {
      return true;
    }

    page._btrix_adInterceptionAdded = true;

    await page.setRequestInterception(true);

    const logDetails = {page: page.url()};

    page.on("request", async (request) => {
      try {
        await this.handleRequest(request, logDetails);
      } catch (e) {
        this.logger.warn("Error handling request", {...logDetails, ...e}, "blocking");
      }
    });
  }

  async shouldBlock(request, url, logDetails) {
    const fragments = url.split("/");
    const domain = fragments.length > 2 ? fragments[2] : null;
    if (this.adhosts.includes(domain)) {
      this.logger.debug("URL blocked for being an ad", {...logDetails, url}, "blocking");
      await this.recordBlockMsg(url);
      return BlockState.BLOCK_AD;
    }
    return BlockState.ALLOW;
  }
}
