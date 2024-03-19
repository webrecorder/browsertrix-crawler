import { logger } from "./logger.js";
import { MAX_DEPTH } from "./constants.js";

type ScopeType =
  | "prefix"
  | "host"
  | "domain"
  | "page"
  | "page-spa"
  | "any"
  | "custom";

export class ScopedSeed {
  url: string;
  scopeType: ScopeType;
  include: RegExp[];
  exclude: RegExp[];
  allowHash = false;
  depth = -1;
  sitemap?: string | null;

  maxExtraHops = 0;
  maxDepth = 0;

  _includeStr: string[];
  _excludeStr: string[];

  constructor({
    url,
    scopeType,
    include,
    exclude,
    allowHash = false,
    depth = -1,
    sitemap = false,
    extraHops = 0,
  }: {
    url: string;
    scopeType: ScopeType;
    include: string[];
    exclude: string[];
    allowHash?: boolean;
    depth?: number;
    sitemap?: string | boolean | null;
    extraHops?: number;
  }) {
    const parsedUrl = this.parseUrl(url);
    if (!parsedUrl) {
      throw new Error("Invalid URL");
    }
    this.url = parsedUrl.href;
    this.include = this.parseRx(include);
    this.exclude = this.parseRx(exclude);
    this.scopeType = scopeType;

    this._includeStr = include;
    this._excludeStr = exclude;

    if (!this.scopeType) {
      this.scopeType = this.include.length ? "custom" : "prefix";
    }

    if (this.scopeType !== "custom") {
      const [includeNew, allowHashNew] = this.scopeFromType(
        this.scopeType,
        parsedUrl,
      );
      this.include = [...includeNew, ...this.include];
      allowHash = allowHashNew;
    }

    // for page scope, the depth is set to extraHops, as no other
    // crawling is done
    if (this.scopeType === "page") {
      depth = extraHops;
    }

    this.sitemap = this.resolveSiteMap(sitemap);
    this.allowHash = allowHash;
    this.maxExtraHops = extraHops;
    this.maxDepth = depth < 0 ? MAX_DEPTH : depth;
  }

  parseRx(value: string[] | RegExp[] | string | null | undefined) {
    if (value === null || value === undefined || value === "") {
      return [];
    } else if (!(value instanceof Array)) {
      return [new RegExp(value)];
    } else {
      return value.map((e) => (e instanceof RegExp ? e : new RegExp(e)));
    }
  }

  newScopedSeed(url: string) {
    return new ScopedSeed({
      url,
      scopeType: this.scopeType,
      include: this._includeStr,
      exclude: this._excludeStr,
      allowHash: this.allowHash,
      depth: this.maxDepth,
      extraHops: this.maxExtraHops,
    });
  }

  addExclusion(value: string | RegExp) {
    if (!value) {
      return;
    }
    if (!(value instanceof RegExp)) {
      value = new RegExp(value);
    }
    this.exclude.push(value);
  }

  removeExclusion(value: string) {
    for (let i = 0; i < this.exclude.length; i++) {
      if (this.exclude[i].toString() == value.toString()) {
        this.exclude.splice(i, 1);
        return true;
      }
    }
  }

  parseUrl(url: string, logDetails = {}) {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url.trim());
    } catch (e) {
      logger.warn("Invalid Page - not a valid URL", { url, ...logDetails });
      return null;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
      logger.warn("Invalid Page - URL must start with http:// or https://", {
        url,
        ...logDetails,
      });
      parsedUrl = null;
    }

    return parsedUrl;
  }

  resolveSiteMap(sitemap: boolean | string | null): string | null {
    if (sitemap === true) {
      return "<detect>";
    } else if (typeof sitemap === "string") {
      return sitemap;
    }

    return null;
  }

  scopeFromType(scopeType: ScopeType, parsedUrl: URL): [RegExp[], boolean] {
    let include: RegExp[] = [];
    let allowHash = false;

    switch (scopeType) {
      case "page":
        include = [];
        break;

      case "page-spa":
        // allow scheme-agnostic URLS as likely redirects
        include = [
          new RegExp("^" + urlRxEscape(parsedUrl.href, parsedUrl) + "#.+"),
        ];
        allowHash = true;
        break;

      case "prefix":
        include = [
          new RegExp(
            "^" +
              urlRxEscape(
                parsedUrl.origin +
                  parsedUrl.pathname.slice(
                    0,
                    parsedUrl.pathname.lastIndexOf("/") + 1,
                  ),
                parsedUrl,
              ),
          ),
        ];
        break;

      case "host":
        include = [
          new RegExp("^" + urlRxEscape(parsedUrl.origin + "/", parsedUrl)),
        ];
        break;

      case "domain":
        if (parsedUrl.hostname.startsWith("www.")) {
          parsedUrl.hostname = parsedUrl.hostname.replace("www.", "");
        }
        include = [
          new RegExp(
            "^" +
              urlRxEscape(parsedUrl.origin + "/", parsedUrl).replace(
                "\\/\\/",
                "\\/\\/([^/]+\\.)*",
              ),
          ),
        ];
        break;

      case "any":
        include = [/.*/];
        break;

      default:
        logger.fatal(
          `Invalid scope type "${scopeType}" specified, valid types are: page, page-spa, prefix, host, domain, any`,
        );
    }

    return [include, allowHash];
  }

  isAtMaxDepth(depth: number) {
    return depth >= this.maxDepth;
  }

  isIncluded(url: string, depth: number, extraHops = 0, logDetails = {}) {
    if (depth > this.maxDepth) {
      return false;
    }

    const urlParsed = this.parseUrl(url, logDetails);
    if (!urlParsed) {
      return false;
    }

    if (!this.allowHash) {
      // remove hashtag
      urlParsed.hash = "";
    }

    url = urlParsed.href;

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

    return { url, isOOS };
  }
}

export function rxEscape(string: string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function urlRxEscape(url: string, parsedUrl: URL) {
  return rxEscape(url).replace(parsedUrl.protocol, "https?:");
}
