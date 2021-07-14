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
        exclude.urlRx = new RegExp(exclude.urlRx);
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

    const {urlRx, frameTextMatchRx, frameTextNotMatchRx} = rule;

    if (!url.match(urlRx)) {
      return false;
    }

    // not a frame text-based rule, always exclude if rx matched
    if (!frameTextMatchRx && !frameTextNotMatchRx) {
      return true;
    }

    // frame text-based match: only applies to nav requests, never exclude otherwise
    if (!request.isNavigationRequest()) {
      return false;
    }

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

    return true;
  }
}

module.exports.Exclusions = Exclusions;

