const fetch = require("node-fetch");

const RULE_TYPES = ["block", "allowOnly"];


// ===========================================================================
class Exclusions
{
  constructor(exclusions) {
    this.exclusions = [];

    for (const exclude of exclusions) {
      if (typeof(exclude) === "string") {
        this.exclusions.push({url: new RegExp(exclude)});
      } else {
        exclude.url = exclude.url ? new RegExp(exclude.url) : null;
        exclude.frameTextMatch = exclude.frameTextMatch ? new RegExp(exclude.frameTextMatch) : null;
        exclude.inFrameUrl = exclude.inFrameUrl ? new RegExp(exclude.inFrameUrl) : null;
        this.exclusions.push(exclude);
      }
    }

    console.log("URL Exclusions", this.exclusions);
  }

  async initPage(page) {
    await page.setRequestInterception(true);

    page.on("request", (request) => this.handleRequest(request));
  }

  async handleRequest(request) {
    const url = request.url();

    if (!url.startsWith("http:") && !url.startsWith("https:")) {
      request.continue();
      return;
    }

    for (const rule of this.exclusions) {
      const {done, exclude} = await this.shouldExclude(rule, request);

      if (exclude) {
        const frameUrl = request.frame().url();
        console.log("Excluding/Aborting Request for: " + request.url(), frameUrl);
        // not allowed, abort loading this response
        request.abort();
        return;
      }
      if (done) {
        break;
      }
    }

    request.continue();
  }

  async shouldExclude(rule, request) {
    const reqUrl = request.url();

    const {url, inFrameUrl, frameTextMatch} = rule;

    const type = rule.type || "block";
    const allowOnly = (type === "allowOnly");

    if (!RULE_TYPES.includes(type)) {
      throw new Error("Rule \"type\" must be: " + RULE_TYPES.join(", "));
    }

    const frameUrl = request.frame().url();

    // ignore initial page
    if (frameUrl === "about:blank") {
      return {exclude: false, done: true};
    }

    // not a frame match, skip rule
    if (inFrameUrl && !frameUrl.match(inFrameUrl)) {
      return {exclude: false, done: false};
    }

    // if frame text-based rule: apply if nav frame
    // frame text-based match: only applies to nav requests, never exclude otherwise
    if (frameTextMatch) {
      if (!request.isNavigationRequest()) {
        return {exclude: false, done: false};
      }

      const exclude = await this.isTextMatch(request, reqUrl, frameTextMatch) ? !allowOnly : allowOnly;
      return {exclude, done: true};
    }


    // for non frame text rule, simply match by URL
    const exclude = (url && reqUrl.match(url)) ? !allowOnly : allowOnly;
    return {exclude, done: false};
  }

  async isTextMatch(request, reqUrl, frameTextMatch) {
    try {
      const res = await fetch(reqUrl);
      const text = await res.text();

      return !!text.match(frameTextMatch);

    } catch (e) {
      console.log(e);
    }
  }
}

module.exports.Exclusions = Exclusions;

