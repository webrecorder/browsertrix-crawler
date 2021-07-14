const fetch = require("node-fetch");


// ===========================================================================
class Exclusions
{
  constructor(exclusions) {
    this.exclusions = [];

    for (const exclude of exclusions) {
      if (typeof(exclude) === "string") {
        this.exclusions.push({urlRx: new RegExp(exclude)});
      } else {
        exclude.urlRx = exclude.urlRx ? new RegExp(exclude.urlRx) : null;
        exclude.notUrlRx = exclude.notUrlRx ? new RegExp(exclude.notUrlRx) : null;

        if (exclude.frameTextMatchRx && exclude.frameTextNotMatchRx) {
          throw new Error("Error: Only one of 'frameTextMatchRx' and 'frameTextNotMatchRx' can be included in each rule.");
        }
        if (exclude.frameTextMatchRx) {
          exclude.frameTextMatchRx = new RegExp(exclude.frameTextMatchRx);
        } else if (exclude.frameTextNotMatchRx) {
          exclude.frameTextNotMatchRx = new RegExp(exclude.frameTextNotMatchRx);
        }
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
      if (await this.shouldExclude(rule, request)) {
        console.log("Excluding/Aborting Request for: " + request.url());
        // not allowed, abort loading this response
        request.abort();
        return;
      }
    }

    request.continue();
  }

  async shouldExclude(rule, request) {
    const url = request.url();

    const {urlRx, pageRx, notUrlRx, frameTextMatchRx, frameTextNotMatchRx} = rule;

    const pageUrl = request.frame().url();

    // ignore initial page
    if (pageUrl === "about:blank") {
      return false;
    }

    if (!urlRx === !notUrlRx) {
      console.log(urlRx, notUrlRx);
      throw new Error("Exactly one of 'urlRx' or 'notUrlRx' must be specified");
    }

    // not a page match, skip rule
    if (pageRx && !pageUrl.match(pageRx)) {
      return false;
    }

    // not a url match, skip rule
    if ((urlRx && !url.match(urlRx)) || (notUrlRx && url.match(notUrlRx))) {
      return false;
    }

    // if frame text-based rule: apply if nav frame
    // frame text-based match: only applies to nav requests, never exclude otherwise
    if ((frameTextMatchRx || frameTextNotMatchRx) && request.isNavigationRequest()) {
      return await this.shouldExcludeFrame(request, url, frameTextMatchRx, frameTextNotMatchRx);
    }

    return true;
  }

  async shouldExcludeFrame(request, url, frameTextMatchRx, frameTextNotMatchRx) {
    try {
      const res = await fetch(url);
      const text = await res.text();

      if (frameTextNotMatchRx) {
        // exclude if not matched
        console.log(`${!text.match(frameTextNotMatchRx) ? "BLOCKED" : "NOT BLOCKED"} because text of ${url} matched ${frameTextNotMatchRx}`);
        return text.match(frameTextNotMatchRx) ? false : true;
      } else {
        // exclude if matched
        console.log(`${text.match(frameTextNotMatchRx) ? "BLOCKED" : "NOT BLOCKED"} because text of ${url} did not match ${frameTextMatchRx}`);
        return text.match(frameTextMatchRx) ? true : false;
      }

    } catch (e) {
      console.log(e);
    }
  }
}

module.exports.Exclusions = Exclusions;

