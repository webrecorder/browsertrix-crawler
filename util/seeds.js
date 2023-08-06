import { logger } from "./logger.js";
import { MAX_DEPTH } from "./constants.js";


export class ScopedSeed
{
  constructor({url, scopeType, include, exclude = [], allowHash = false, depth = -1, sitemap = false, extraHops = 0} = {}) {
    const parsedUrl = this.parseUrl(url);
    if (!parsedUrl) {
      logger.fatal(`Invalid Seed "${url}" specified, aborting crawl.`);
    }
    this.url = parsedUrl.href;
    this.include = this.parseRx(include);
    this.exclude = this.parseRx(exclude);
    this.scopeType = scopeType;

    if (!this.scopeType) {
      this.scopeType = this.include.length ? "custom" : "prefix";
    }

    if (this.scopeType !== "custom") {
      [include, allowHash] = this.scopeFromType(this.scopeType, parsedUrl);
      this.include = [...include, ...this.include];
    }

    this.sitemap = this.resolveSiteMap(sitemap);
    this.allowHash = allowHash;
    this.maxExtraHops = extraHops;
    this.maxDepth = depth < 0 ? MAX_DEPTH : depth;
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

  parseUrl(url, logDetails = {}) {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url.trim());
    } catch (e) {
      logger.warn("Invalid Page - not a valid URL", {url, ...logDetails});
      return null;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
      logger.warn("Invalid Page - URL must start with http:// or https://", {url, ...logDetails});
      parsedUrl = null;
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
      if (parsedUrl.hostname.startsWith("www.")) {
        parsedUrl.hostname = parsedUrl.hostname.replace("www.", "");
      }
      include = [new RegExp("^" + urlRxEscape(parsedUrl.origin + "/", parsedUrl).replace("\\/\\/", "\\/\\/([^/]+\\.)*"))];
      break;

    case "any":
      include = [/.*/];
      break;

    default:
      logger.fatal(`Invalid scope type "${scopeType}" specified, valid types are: page, page-spa, prefix, host, domain, any`);
    }

    return [include, allowHash];
  }

  isAtMaxDepth(depth) {
    return depth >= this.maxDepth;
  }

  isIncluded(url, depth, extraHops = 0, logDetails = {}) {
    if (depth > this.maxDepth) {
      return false;
    }

    url = this.parseUrl(url, logDetails);
    if (!url) {
      return false;
    }

    if (!this.allowHash) {
      // remove hashtag
      url.hash = "";
    }

    url = url.href;

    if (url === this.url) {
      return true;
    }

    // skip already crawled
    // if (this.seenList.has(url)) {
    //  return false;
    //}
    let inScope = false;

    // check scopes
    for (const s of this.include) {
      if (s.test(url)) {
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
      if (e.test(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return false;
      }
    }

    return {url, isOOS};
  }
}

export function rxEscape(string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function urlRxEscape(url, parsedUrl) {
  return rxEscape(url).replace(parsedUrl.protocol, "https?:");
}




