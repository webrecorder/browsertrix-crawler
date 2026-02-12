import { Readable } from "stream";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";
import { DETECT_SITEMAP } from "./constants.js";
import { sleep } from "./timing.js";

import { Dispatcher, request } from "undici";
import { getProxyDispatcher } from "./proxy.js";

const SITEMAP_CONCURRENCY = 5;

const TEXT_CONTENT_TYPE = ["text/plain"];
const XML_CONTENT_TYPES = ["text/xml", "application/xml"];

export type SitemapOpts = {
  headers?: Record<string, string>;

  fromDate?: Date;
  toDate?: Date;

  limit?: number;
};

export class SitemapReader extends EventEmitter {
  headers?: Record<string, string>;

  fromDate?: Date;
  toDate?: Date;

  queue: PQueue;

  seenSitemapSet: Set<string>;
  pending = 0;

  count = 0;
  limit: number;

  constructor(opts: SitemapOpts) {
    super();
    this.headers = opts.headers;

    this.queue = new PQueue({ concurrency: SITEMAP_CONCURRENCY });

    this.fromDate = opts.fromDate;
    this.toDate = opts.toDate;

    this.seenSitemapSet = new Set<string>();

    this.limit = opts.limit || 0;
  }

  getCT(headers: Headers) {
    const ct = headers.get("content-type");
    if (!ct) {
      return null;
    }
    return ct.split(";")[0];
  }

  async _fetchWithRetry(url: string, expectedCT = XML_CONTENT_TYPES) {
    while (true) {
      const resp = await request(url, {
        headers: this.headers,
        dispatcher: getProxyDispatcher(url),
      });

      const { statusCode, headers } = resp;

      if (statusCode === 200) {
        const ct = headers["content-type"] as string;
        if (expectedCT && ct && !expectedCT.includes(ct.split(";")[0])) {
          logger.debug(
            "Not loading sitemap: invalid content-type",
            { ct },
            "sitemap",
          );
          return null;
        }
        return resp;
      }

      const retry = headers["retry-after"];

      if (retry) {
        logger.debug(
          "Sitemap Fetch: Retry after",
          { retrySeconds: retry },
          "sitemap",
        );
        await sleep(parseInt(retry as string));
        continue;
      }

      logger.debug(
        "Not loading sitemap: invalid status code",
        { status: statusCode },
        "sitemap",
      );
      return null;
    }
  }

  async parse(sitemap: string, seedUrl: string) {
    let found = false;

    if (sitemap === DETECT_SITEMAP) {
      // if set to auto-detect, eg. --sitemap / --useSitemap with no URL
      // 1. first check robots.txt
      // 2. if not found, check /sitemap.xml
      logger.debug("Detecting sitemap for seed", { seedUrl }, "sitemap");
      const robotsUrl = new URL("/robots.txt", seedUrl).href;
      found = await this.parseRobotsForSitemap(robotsUrl);

      const sitemapUrl = new URL("/sitemap.xml", seedUrl).href;

      if (!found) {
        found = await this.parseSitemap(sitemapUrl);
      }
      if (!found) {
        logger.debug(
          "Sitemap not detected in robots.txt or sitemap.xml",
          { robotsUrl, sitemapUrl, seedUrl },
          "sitemap",
        );
      }
    } else {
      // if specific URL provided, check if its a .xml file or a robots.txt file
      const fullUrl = new URL(sitemap, seedUrl).href;
      if (fullUrl.endsWith(".xml") || fullUrl.endsWith(".xml.gz")) {
        found = await this.parseSitemap(fullUrl);
      } else if (fullUrl.endsWith(".txt")) {
        found = await this.parseRobotsForSitemap(fullUrl);
      } else {
        logger.debug(
          "URL provided must be a sitemap XML or robots TXT file",
          { sitemap, seedUrl, fullUrl },
          "sitemap",
        );
      }
    }

    return found;
  }

  private async parseRobotsForSitemap(robotsUrl: string) {
    let sitemapFound = false;
    try {
      logger.debug(
        "Sitemap: Parsing robots to detect sitemap",
        { url: robotsUrl },
        "sitemap",
      );
      const resp = await this._fetchWithRetry(robotsUrl, TEXT_CONTENT_TYPE);
      if (!resp) {
        return sitemapFound;
      }

      const { body } = resp;

      const text = await body.text();

      text.replace(/^Sitemap:\s?([^\s]+)$/gim, (m, urlStr) => {
        try {
          const url = new URL(urlStr, robotsUrl).href;
          logger.debug("Sitemap: Added from robots", { url }, "sitemap");
          this.addNewSitemap(url, null);
          sitemapFound = true;
        } catch (e) {
          // ignore invalid
        }
        return urlStr;
      });
    } catch (e) {
      //
    }
    return sitemapFound;
  }

  async parseSitemap(url: string) {
    try {
      this.seenSitemapSet.add(url);

      logger.debug("Parsing sitemap XML", url, "sitemap");

      const resp = await this._fetchWithRetry(url);
      if (!resp) {
        return false;
      }

      await this.parseSitemapFromResponse(url, resp);

      return true;
    } catch (e) {
      logger.warn("Sitemap parse failed", { url, ...formatErr(e) }, "sitemap");
      return false;
    } finally {
      await this.checkIfDone();
    }
  }

  private async parseSitemapFromResponse(
    url: string,
    resp: Dispatcher.ResponseData,
  ) {
    let resolve: () => void;
    let reject: () => void;

    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pending++;

    try {
      this.doParseSitemapFromResponse(url, resp, resolve!, reject!);

      await promise;
    } finally {
      this.pending--;
    }
  }

  async checkIfDone() {
    if (!this.pending) {
      // this needs to happen async since if its in the current task,
      // queue won't be idle until this completes
      setTimeout(async () => {
        await this.queue.onIdle();
        this.emit("end");
      }, 100);
    }
  }

  private doParseSitemapFromResponse(
    url: string,
    resp: Dispatcher.ResponseData,
    resolve: () => void,
    reject: () => void,
  ) {
    const { body } = resp;
    if (!body) {
      logger.warn("Sitemap missing response body", {}, "sitemap");
      reject();
      return;
    }

    body.on("error", (e: Error) => {
      logger.warn("Error parsing sitemap", formatErr(e), "sitemap");
      reject();
    });

    this.initSaxParser(url, body, resolve, reject);
  }

  private initSaxParser(
    url: string,
    sourceStream: Readable,
    resolve: () => void,
    reject: () => void,
  ) {
    const parserStream = sax.createStream(false, {
      trim: true,
      normalize: true,
      lowercase: true,
    });

    let parsingSitemapIndex = false;
    let parsingSitemap = false;

    let parsingUrlset = false;
    let parsingUrl = false;
    let parsingLoc = false;
    let parsingLastmod = false;

    let currUrl: string | null;
    let lastmod: Date | null = null;

    let errCount = 0;

    let otherTags = 0;

    const processText = (text: string) => {
      if (parsingLoc) {
        currUrl = text;
      } else if (parsingLastmod) {
        try {
          lastmod = new Date(text);
        } catch (e) {
          lastmod = null;
        }
      } else if (!otherTags) {
        if (parsingUrl) {
          logger.debug("text in url, ignoring", {}, "sitemap");
        } else if (parsingUrlset) {
          logger.debug("text in urlset, ignoring", {}, "sitemap");
        } else if (parsingSitemap) {
          logger.debug("text in sitemap, ignoring", {}, "sitemap");
        } else if (parsingSitemapIndex) {
          logger.debug("text in sitemapindex, ignoring", {}, "sitemap");
        }
      }
    };

    parserStream.on("end", () => resolve());

    parserStream.on("opentag", (node: sax.Tag) => {
      switch (node.name) {
        // Single Sitemap
        case "url":
          parsingUrl = true;
          break;

        case "loc":
          parsingLoc = true;
          break;

        case "lastmod":
          parsingLastmod = true;
          break;

        case "urlset":
          parsingUrlset = true;
          break;

        // Sitemap Index
        case "sitemapindex":
          parsingSitemapIndex = true;
          break;

        case "sitemap":
          parsingSitemap = true;
          break;

        default:
          otherTags++;
      }
    });

    parserStream.on("closetag", (tagName: string) => {
      switch (tagName) {
        // Single Sitemap
        case "url":
          this.emitEntry(currUrl, lastmod);
          if (this.atLimit()) {
            parserStream._parser.close();
          }
          currUrl = null;
          lastmod = null;
          parsingUrl = false;
          break;

        case "loc":
          parsingLoc = false;
          break;

        case "lastmod":
          parsingLastmod = false;
          break;

        case "urlset":
          parsingUrlset = false;
          break;

        // Sitemap Index
        case "sitemapindex":
          parsingSitemapIndex = false;
          break;

        case "sitemap":
          if (currUrl) {
            this.addNewSitemap(currUrl, lastmod);
          }
          currUrl = null;
          lastmod = null;
          parsingSitemap = false;
          break;

        default:
          otherTags--;
      }
    });

    parserStream.on("text", (text: string) => processText(text));
    parserStream.on("cdata", (text: string) => processText(text));

    let limitLogged = false;

    parserStream.on("error", (err: Error) => {
      const msg = { url, err, errCount };
      if (this.atLimit()) {
        if (!limitLogged) {
          logger.warn(
            "Sitemap parsing aborting, page limit reached",
            msg,
            "sitemap",
          );
          limitLogged = true;
        }
        resolve();
      } else {
        logger.warn("Sitemap error parsing XML", msg, "sitemap");
        if (errCount++ < 3) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (parserStream._parser as any).error = null;
          parserStream._parser.resume();
        } else {
          reject();
        }
      }
    });

    sourceStream.pipe(parserStream);
  }

  atLimit(): boolean {
    return Boolean(this.limit && this.count >= this.limit);
  }

  isWithinRange(lastmod: Date | null) {
    // always accept entries with no date -- add option to change?
    if (!lastmod) {
      return true;
    }

    // earlier than fromDate
    if (this.fromDate && lastmod < this.fromDate) {
      return false;
    }

    // later than toDate
    if (this.toDate && lastmod > this.toDate) {
      return false;
    }

    return true;
  }

  addNewSitemap(url: string, lastmod: Date | null) {
    if (this.seenSitemapSet.has(url)) {
      return;
    }

    if (!this.isWithinRange(lastmod)) {
      return;
    }

    if (this.atLimit()) {
      return;
    }

    void this.queue.add(() => this.parseSitemap(url));
  }

  emitEntry(url: string | null, lastmod: Date | null) {
    if (!url) {
      return;
    }

    if (!this.isWithinRange(lastmod)) {
      return;
    }

    if (this.atLimit()) {
      this.queue.clear();
      return;
    }

    this.emit("url", { url, lastmod });

    this.count++;
  }

  getSitemapsQueued() {
    return this.queue.size;
  }

  getNumPending() {
    return this.pending;
  }
}
