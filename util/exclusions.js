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
        exclude.textMatchRx = new RegExp(exclude.textMatchRx);
        // should be bool
        exclude.includeMatch = !!exclude.includeMatch;
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

    const {urlRx, textMatchRx, includeMatch} = rule;

    if (!url.match(urlRx)) {
      return false;
    }

    if (!textMatchRx) {
      return true;
    }

    console.log("Matched Rule for: " + url, textMatchRx);

    try {
      const res = await fetch(url);
      const text = await res.text();

      // return true if includeMatch, otherwise include matched
      return text.match(textMatchRx) ? !includeMatch : includeMatch;

    } catch (e) {
      console.log(e);
    }

    return true;
  }
}

module.exports.Exclusions = Exclusions;

