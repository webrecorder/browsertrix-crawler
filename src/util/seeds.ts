import fs from "fs";

import { MAX_DEPTH } from "./constants.js";
import { collectOnlineSeedFile } from "./file_reader.js";
import { logger } from "./logger.js";
import { type CrawlerArgs } from "./argParser.js";

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
  auth: string | null = null;
  private _authEncoded: string | null = null;

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
    auth = null,
  }: {
    url: string;
    scopeType: ScopeType | undefined;
    include: string[];
    exclude: string[];
    allowHash?: boolean;
    depth?: number;
    sitemap?: string | boolean | null;
    extraHops?: number;
    auth?: string | null;
  }) {
    const parsedUrl = this.parseUrl(url);
    if (!parsedUrl) {
      throw new Error("Invalid URL");
    }
    if (auth || (parsedUrl.username && parsedUrl.password)) {
      this.auth = auth || parsedUrl.username + ":" + parsedUrl.password;
      this._authEncoded = btoa(this.auth);
    }
    parsedUrl.username = "";
    parsedUrl.password = "";

    this.url = parsedUrl.href;
    this.include = parseRx(include);
    this.exclude = parseRx(exclude);

    this._includeStr = include;
    this._excludeStr = exclude;

    if (!scopeType) {
      scopeType = this.include.length ? "custom" : "prefix";
    }
    this.scopeType = scopeType;

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

  authHeader() {
    return this._authEncoded ? "Basic " + this._authEncoded : null;
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
      auth: this.auth,
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

  isAtMaxDepth(depth: number, extraHops: number) {
    return depth >= this.maxDepth && extraHops >= this.maxExtraHops;
  }

  isIncluded(
    url: string,
    depth: number,
    extraHops = 0,
    logDetails = {},
    noOOS = false,
  ): { url: string; isOOS: boolean } | false {
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
      return { url, isOOS: false };
    }

    // skip already crawled
    // if (this.seenList.has(url)) {
    //  return false;
    //}
    let inScope = false;

    // check scopes if depth <= maxDepth
    // if depth exceeds, than always out of scope
    if (depth <= this.maxDepth) {
      for (const s of this.include) {
        if (s.test(url)) {
          inScope = true;
          break;
        }
      }
    }

    let isOOS = false;

    if (!inScope) {
      if (!noOOS && this.maxExtraHops && extraHops <= this.maxExtraHops) {
        isOOS = true;
      } else {
        //console.log(`Not in scope ${url} ${this.include}`);
        return false;
      }
    }

    if (this.isExcluded(url)) {
      return false;
    }

    return { url, isOOS };
  }

  isExcluded(url: string) {
    // check exclusions
    for (const e of this.exclude) {
      if (e.test(url)) {
        //console.log(`Skipping ${url} excluded by ${e}`);
        return true;
      }
    }

    return false;
  }
}

export async function parseSeeds(params: CrawlerArgs): Promise<ScopedSeed[]> {
  let seeds = params.seeds as string[];
  const scopedSeeds: ScopedSeed[] = [];

  if (params.seedFile) {
    let seedFilePath = params.seedFile as string;
    if (
      seedFilePath.startsWith("http://") ||
      seedFilePath.startsWith("https://")
    ) {
      seedFilePath = await collectOnlineSeedFile(seedFilePath);
    }

    const urlSeedFile = fs.readFileSync(seedFilePath, "utf8");
    const urlSeedFileList = urlSeedFile.split("\n");

    if (typeof seeds === "string") {
      seeds = [seeds];
    }

    for (const seed of urlSeedFileList) {
      if (seed) {
        seeds.push(seed);
      }
    }
  }

  const scopeOpts = {
    scopeType: params.scopeType as ScopeType | undefined,
    sitemap: params.sitemap,
    include: params.include,
    exclude: params.exclude,
    depth: params.depth,
    extraHops: params.extraHops,
  };

  for (const seed of seeds) {
    const newSeed = typeof seed === "string" ? { url: seed } : seed;
    newSeed.url = removeQuotes(newSeed.url);

    try {
      scopedSeeds.push(new ScopedSeed({ ...scopeOpts, ...newSeed }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      logger.error("Failed to create seed", {
        error: e.toString(),
        ...scopeOpts,
        ...newSeed,
      });
      if (params.failOnFailedSeed) {
        logger.fatal(
          "Invalid seed specified, aborting crawl",
          { url: newSeed.url },
          "general",
          1,
        );
      }
    }
  }

  if (!params.qaSource && !scopedSeeds.length) {
    logger.fatal("No valid seeds specified, aborting crawl");
  }

  return scopedSeeds;
}

export function rxEscape(string: string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function urlRxEscape(url: string, parsedUrl: URL) {
  return rxEscape(url).replace(parsedUrl.protocol, "https?:");
}

export function parseRx(
  value: string[] | RegExp[] | string | null | undefined,
) {
  if (value === null || value === undefined || value === "") {
    return [];
  } else if (!(value instanceof Array)) {
    return [new RegExp(value)];
  } else {
    return value.map((e) => (e instanceof RegExp ? e : new RegExp(e)));
  }
}

export function removeQuotes(url: string) {
  url = url.trim();
  if (
    (url.startsWith(`"`) && url.endsWith(`"`)) ||
    (url.startsWith(`'`) && url.endsWith(`'`))
  ) {
    url = url.slice(1, -1);
  }
  return url;
}
