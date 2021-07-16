class ScopedSeed
{
  constructor({url, scopeType, include, exclude = [], allowHash = false, depth = -1, sitemap = false} = {}) {
    const parsedUrl = this.parseUrl(url);
    this.url = parsedUrl.href;
    this.include = this.parseRx(include);
    this.exclude = this.parseRx(exclude);

    if (!scopeType) {
      scopeType = (this.include.length || this.exclude.length) ? "custom" : "prefix";
    }

    this.scopeType = scopeType;

    if (this.scopeType !== "custom") {
      [this.include, allowHash] = this.scopeFromType(this.scopeType, parsedUrl);
    }
    this.sitemap = this.resolveSiteMap(sitemap);
    this.allowHash = allowHash;
    this.maxDepth = depth < 0 ? 99999 : depth;
  }

  parseRx(value) {
    if (!value) {
      return [];
    } else if (typeof(value) === "string") {
      return [new RegExp(value)];
    } else {
      return value.map(e => typeof(e) === "string" ? new RegExp(e) : e);
    }
  }

  parseUrl(url) {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
      throw new Error("URL must start with http:// or https://");
    }

    return parsedUrl;
  }

  resolveSiteMap(sitemap) {
    if (sitemap === true) {
      const url = new URL(this.url);
      url.pathname = "/sitemap.xml";
      return url.href;
    }

    return sitemap;
  }

  scopeFromType(scopeType, parsedUrl) {
    let include;
    let allowHash = false;

    switch (scopeType) {
    case "page":
      // allow scheme-agnostic URLS as likely redirects
      include = [new RegExp("^" + rxEscape(parsedUrl.href).replace(parsedUrl.protocol, "https?:") + "#.+")];
      allowHash = true;
      break;

    case "prefix":
      include = [new RegExp("^" + rxEscape(parsedUrl.origin + parsedUrl.pathname.slice(0, parsedUrl.pathname.lastIndexOf("/") + 1)))];
      break;

    case "host":
      include = [new RegExp("^" + rxEscape(parsedUrl.origin + "/"))];
      break;

    case "any":
      include = [/.*/];
      break;

    case "none":
      include = [];
      break;

    default:
      throw new Error(`Invalid scope type "${scopeType}" specified, valid types are: page, prefix, host`);
    }

    return [include, allowHash];
  }

  isAtMaxDepth(depth) {
    return depth >= this.maxDepth;
  }

  isIncluded(url, depth) {
    if (depth > this.maxDepth) {
      return false;
    }

    try {
      url = this.parseUrl(url);
    } catch(e) {
      return false;
    }

    if (!this.allowHash) {
      // remove hashtag
      url.hash = "";
    }

    url = url.href;

    // skip already crawled
    // if (this.seenList.has(url)) {
    //  return false;
    //}
    let inScope = false;

    // check scopes
    for (const s of this.include) {
      if (s.exec(url)) {
        inScope = true;
        break;
      }
    }

    if (!inScope) {
      //console.log(`Not in scope ${url} ${this.include}`);
      return false;
    }

    // check exclusions
    for (const e of this.exclude) {
      if (e.exec(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return false;
      }
    }

    return url;
  }
}

function rxEscape(string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}



module.exports.ScopedSeed = ScopedSeed;
module.exports.rxEscape = rxEscape;

