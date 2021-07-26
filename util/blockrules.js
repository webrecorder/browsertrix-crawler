const fetch = require("node-fetch");

const RULE_TYPES = ["block", "allowOnly"];


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
    this.putUrlSet = new Set();

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

    await page.setRequestInterception(true);

    page.on("request", async (request) => {
      try {
        await this.handleRequest(request);
      } catch (e) {
        console.warn(e);
      }
    });
  }

  async handleRequest(request) {
    const url = request.url();

    if (!url.startsWith("http:") && !url.startsWith("https:")) {
      request.continue();
      return;
    }

    for (const rule of this.rules) {
      const {done, block, frameUrl} = await this.shouldBlock(rule, request);

      if (block) {
        request.abort();
        await this.recordBlockMsg(request.url(), frameUrl);
        return;
      }
      if (done) {
        break;
      }
    }

    request.continue();
  }

  async shouldBlock(rule, request) {
    const reqUrl = request.url();

    const {url, inFrameUrl, frameTextMatch} = rule;

    const type = rule.type || "block";
    const allowOnly = (type === "allowOnly");

    const isNavReq = request.isNavigationRequest();

    const frame = request.frame();

    let frameUrl = null;

    if (isNavReq) {
      const parentFrame = frame.parentFrame();
      if (parentFrame) {
        frameUrl = parentFrame.url();
      } else {
        frameUrl = frame.url();
      }
    } else {
      frameUrl = frame.url();
    }

    // ignore initial page
    if (frameUrl === "about:blank") {
      return {block: false, done: true, frameUrl};
    }

    // not a frame match, skip rule
    if (inFrameUrl && !frameUrl.match(inFrameUrl)) {
      return {block: false, done: false, frameUrl};
    }

    const urlMatched = (url && reqUrl.match(url));

    // if frame text-based rule: if url matched and a frame request
    // frame text-based match: only applies to nav requests, never block otherwise
    if (frameTextMatch) {
      if (!urlMatched || !isNavReq) {
        return {block: false, done: false, frameUrl};
      }

      const block = await this.isTextMatch(request, reqUrl, frameTextMatch) ? !allowOnly : allowOnly;
      this.debugLog(`iframe ${url} conditionally ${block ? "BLOCKED" : "ALLOWED"}, parent frame ${frameUrl}`);
      return {block, done: true, frameUrl};
    }

    // for non frame text rule, simply match by URL
    const block = urlMatched ? !allowOnly : allowOnly;
    return {block, done: false, frameUrl};
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

  async recordBlockMsg(url, frameUrl) {
    this.debugLog(`URL Blocked/Aborted: ${url} in frame ${frameUrl}`);

    if (!this.blockErrMsg || !this.blockPutUrl) {
      return;
    }

    if (this.putUrlSet.has(url)) {
      return;
    }

    this.putUrlSet.add(url);

    const body = this.blockErrMsg;
    const putUrl = new URL(this.blockPutUrl);
    putUrl.searchParams.set("url", url);
    await fetch(putUrl.href, {method: "PUT", headers: {"Content-Type": "text/html"}, body});
  }
}

module.exports.BlockRules = BlockRules;

