const fetch = require("node-fetch");

const RULE_TYPES = ["block", "allowOnly"];

const ALWAYS_ALLOW = ["https://pywb.proxy/", "http://pywb.proxy/"];

const BlockState = {
  ALLOW: null,
  BLOCK_PAGE_NAV: "page",
  BLOCK_IFRAME_NAV: "iframe",
  BLOCK_OTHER: "resource"
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
      throw new Error("Rule \"type\" must be: " + RULE_TYPES.join(", "));
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
class BlockRules
{
  constructor(blockRules, blockPutUrl, blockErrMsg, debugLog) {
    this.rules = [];
    this.blockPutUrl = blockPutUrl;
    this.blockErrMsg = blockErrMsg;
    this.debugLog = debugLog;

    this.blockedUrlSet = new Set();

    for (const ruleData of blockRules) {
      this.rules.push(new BlockRule(ruleData));
    }

    if (this.rules.length) {
      this.debugLog("URL Block Rules:\n");
      for (const rule of this.rules) {
        this.debugLog(rule.toString());
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

    await page.setRequestInterception(true);

    page.on("request", async (request) => {
      try {
        await this.handleRequest(request);
      } catch (e) {
        console.warn(e);
      }
    });

    page._btrix_interceptionAdded = true;
  }

  async handleRequest(request) {
    const url = request.url();

    let blockState;

    try {
      blockState = await this.shouldBlock(request, url);

      if (blockState === BlockState.ALLOW) {
        await request.continue();
      } else {
        await request.abort("blockedbyclient");
      }

    } catch (e) {
      this.debugLog(`Block: (${blockState}) Failed On: ${url} Reason: ${e}`);
    }
  }

  async shouldBlock(request, url) {
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
      const {done, block} = await this.ruleCheck(rule, request, url, frameUrl, isNavReq);

      if (block) {
        if (blockState === BlockState.BLOCK_PAGE_NAV) {
          console.warn(`Warning: Block rule match for page request "${url}" ignored, set --exclude to block full pages`);
          return BlockState.ALLOW;
        }
        this.debugLog(`URL Blocked/Aborted: ${url} in frame ${frameUrl}`);
        await this.recordBlockMsg(url);
        return blockState;
      }
      if (done) {
        break;
      }
    }

    return BlockState.ALLOW;
  }

  async ruleCheck(rule, request, reqUrl, frameUrl, isNavReq) {
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

      const block = await this.isTextMatch(request, reqUrl, frameTextMatch) ? !allowOnly : allowOnly;
      this.debugLog(`iframe ${url} conditionally ${block ? "BLOCKED" : "ALLOWED"}, parent frame ${frameUrl}`);
      return {block, done: true};
    }

    // for non frame text rule, simply match by URL
    const block = urlMatched ? !allowOnly : allowOnly;
    return {block, done: false};
  }

  async isTextMatch(request, reqUrl, frameTextMatch) {
    try {
      const res = await fetch(reqUrl);
      const text = await res.text();

      return !!text.match(frameTextMatch);

    } catch (e) {
      this.debugLog(e);
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

module.exports.BlockRules = BlockRules;

