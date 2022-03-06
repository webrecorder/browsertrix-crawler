class ScopedSeed
{
  constructor({url, scopeType, include, exclude = [], allowHash = false, depth = -1, sitemap = false, extraHops = 0} = {}) {
    const parsedUrl = this.parseUrl(url);
    this.url = parsedUrl.href;
    this.include = this.parseRx(include);
    this.exclude = this.parseRx(exclude);
    this.scopeType = scopeType;

    if (!this.scopeType) {
      this.scopeType = this.include.length ? "custom" : "prefix";
    }

    if (this.scopeType !== "custom") {
      [this.include, allowHash] = this.scopeFromType(this.scopeType, parsedUrl);
    }

    this.sitemap = this.resolveSiteMap(sitemap);
    this.allowHash = allowHash;
    this.maxExtraHops = extraHops;
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
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url.trim());
    } catch (e) {
      throw new Error(`Invalid Seed "${url}" - not a valid URL`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
      throw new Error(`Invalid Seed "${url}" - URL must start with http:// or https://`);
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
      include = [];
      break;

    case "page-spa":
      // allow scheme-agnostic URLS as likely redirects
      include = [new RegExp("^" + urlRxEscape(parsedUrl.href, parsedUrl) + "#.+")];
      allowHash = true;
      break;

    case "prefix":
      include = [new RegExp("^" + urlRxEscape(parsedUrl.origin + parsedUrl.pathname.slice(0, parsedUrl.pathname.lastIndexOf("/") + 1), parsedUrl))];
      break;

    case "host":
      include = [new RegExp("^" + urlRxEscape(parsedUrl.origin + "/", parsedUrl))];
      break;

    case "domain":
      include = [new RegExp("^" + urlRxEscape(parsedUrl.origin + "/", parsedUrl).replace("\\/\\/", "\\/\\/([^/]+\\.)*"))];
      break;

    case "any":
      include = [/.*/];
      break;

    default:
      throw new Error(`Invalid scope type "${scopeType}" specified, valid types are: page, page-spa, prefix, host, domain, any`);
    }

    return [include, allowHash];
  }

  isAtMaxDepth(depth) {
    return depth >= this.maxDepth;
  }

  isIncluded(url, depth, extraHops = 0) {
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

    let isOOS = false;

    if (!inScope) {
      if (this.maxExtraHops && extraHops <= this.maxExtraHops) {
        isOOS = true;
      } else {
        //console.log(`Not in scope ${url} ${this.include}`);
        return false;
      }
    }

    // check exclusions
    for (const e of this.exclude) {
      if (e.exec(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return false;
      }
    }

    return {url, isOOS};
  }
}

function rxEscape(string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function urlRxEscape(url, parsedUrl) {
  return rxEscape(url).replace(parsedUrl.protocol, "https?:");
}



module.exports.ScopedSeed = ScopedSeed;
module.exports.rxEscape = rxEscape;

