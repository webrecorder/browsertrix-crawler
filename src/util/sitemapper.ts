import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";
import { DETECT_SITEMAP } from "./constants.js";
import { sleep } from "./timing.js";

import { fetch, Response } from "undici";
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
  pending: Set<string>;

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

    this.pending = new Set<string>();
  }

  getCT(headers: Headers) {
    const ct = headers.get("content-type");
    if (!ct) {
      return null;
    }
    return ct.split(";")[0];
  }

  async _fetchWithRetry(url: string, message: string) {
    while (true) {
      const resp = await fetch(url, {
        headers: this.headers,
        dispatcher: getProxyDispatcher(),
      });

      if (resp.ok) {
        return resp;
      }

      const retry = resp.headers.get("retry-after");

      if (retry) {
        logger.debug(
          "Sitemap Fetch: Retry after",
          { retrySeconds: retry },
          "sitemap",
        );
        await sleep(parseInt(retry));
        continue;
      }

      logger.debug(message, { status: resp.status }, "sitemap");
      return null;
    }
  }

  async tryFetch(url: string, expectedCT?: string[] | null) {
    try {
      logger.debug(
        "Detecting Sitemap: fetching",
        { url, expectedCT },
        "sitemap",
      );

      const resp = await this._fetchWithRetry(
        url,
        "Detecting Sitemap: invalid status code",
      );

      if (!resp) {
        return null;
      }

      const ct = resp.headers.get("content-type");
      if (expectedCT && ct && !expectedCT.includes(ct.split(";")[0])) {
        logger.debug(
          "Detecting Sitemap: invalid content-type",
          { ct },
          "sitemap",
        );
        return null;
      }

      return resp;
    } catch (e) {
      logger.debug("Detecting Sitemap: unknown error", e, "sitemap");
      return null;
    }
  }

  async parse(sitemap: string, seedUrl: string) {
    let resp: Response | null = null;
    let fullUrl: string | null = null;
    let isRobots = false;
    let isSitemap = false;

    // if set to auto-detect, eg. --sitemap / --useSitemap with no URL
    // 1. first check robots.txt
    // 2. if not found, check /sitemap.xml
    if (sitemap === DETECT_SITEMAP) {
      logger.debug("Detecting sitemap for seed", { seedUrl }, "sitemap");
      fullUrl = new URL("/robots.txt", seedUrl).href;
      resp = await this.tryFetch(fullUrl, TEXT_CONTENT_TYPE);
      if (resp) {
        isRobots = true;
      } else {
        fullUrl = new URL("/sitemap.xml", seedUrl).href;
        resp = await this.tryFetch(fullUrl, XML_CONTENT_TYPES);
        if (resp) {
          isSitemap = true;
        }
      }
    } else {
      // if specific URL provided, check if its a .xml file or a robots.txt file
      fullUrl = new URL(sitemap, seedUrl).href;
      let expected = null;
      if (fullUrl.endsWith(".xml") || fullUrl.endsWith(".xml.gz")) {
        expected = XML_CONTENT_TYPES;
        isSitemap = true;
      } else if (fullUrl.endsWith(".txt")) {
        expected = TEXT_CONTENT_TYPE;
        isRobots = true;
      }
      resp = await this.tryFetch(fullUrl, expected);
    }

    // fail if no successful response fetched
    if (!resp) {
      logger.debug(
        "Sitemap not found",
        { sitemap, seedUrl, fullUrl },
        "sitemap",
      );
      throw new Error("not found");
    }

    // fail if neither an xml nor robots.txt
    if (!isRobots && !isSitemap) {
      logger.info("Sitemap not detected for seed", { seedUrl }, "sitemap");
      throw new Error("not xml or robots.txt");
    }

    if (isRobots) {
      logger.debug(
        "Sitemap: parsing from robots.txt",
        { fullUrl, seedUrl },
        "sitemap",
      );
      await this._parseRobotsFromResponse(resp);
    } else if (isSitemap) {
      logger.debug(
        "Sitemap: parsing from top-level sitemap XML",
        { fullUrl, seedUrl },
        "sitemap",
      );
      this._parseSitemapFromResponse(fullUrl, resp);
    }
  }

  async parseFromRobots(url: string) {
    const resp = await this._fetchWithRetry(
      url,
      "Sitemap robots.txt parse failed",
    );
    if (!resp) {
      return;
    }

    await this._parseRobotsFromResponse(resp);
  }

  private async _parseRobotsFromResponse(resp: Response) {
    const text = await resp.text();

    text.replace(/^Sitemap:\s?([^\s]+)$/gim, (m, url) => {
      this.addNewSitemap(url, null);
      return url;
    });
  }

  async parseSitemap(url: string) {
    this.seenSitemapSet.add(url);
    this.pending.add(url);

    const resp = await this._fetchWithRetry(url, "Sitemap parse failed");
    if (!resp) {
      return;
    }

    this._parseSitemapFromResponse(url, resp);
  }

  private _parseSitemapFromResponse(url: string, resp: Response) {
    let stream;

    const { body } = resp;
    if (!body) {
      void this.closeSitemap(url);
      throw new Error("missing response body");
    }
    // decompress .gz sitemaps
    // if content-encoding is gzip, then likely already being decompressed by fetch api
    if (
      url.endsWith(".gz") &&
      resp.headers.get("content-encoding") !== "gzip"
    ) {
      const ds = new DecompressionStream("gzip");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream = body.pipeThrough(ds as any);
    } else {
      stream = body;
    }

    const readableNodeStream = Readable.fromWeb(
      stream as ReadableStream<Uint8Array>,
    );

    readableNodeStream.on("error", (e: Error) => {
      logger.warn("Error parsing sitemap", formatErr(e), "sitemap");
      void this.closeSitemap(url);
    });

    this.initSaxParser(url, readableNodeStream);
  }

  private async closeSitemap(url: string) {
    this.pending.delete(url);
    if (!this.pending.size) {
      await this.queue.onIdle();
      this.emit("end");
    }
  }

  initSaxParser(url: string, sourceStream: Readable) {
    this.pending.add(url);

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

    parserStream.on("end", () => this.closeSitemap(url));

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

    parserStream.on("error", (err: Error) => {
      if (this.atLimit()) {
        this.pending.delete(url);
        return;
      }
      logger.warn(
        "Sitemap error parsing XML",
        { url, err, errCount },
        "sitemap",
      );
      if (errCount++ < 3) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (parserStream._parser as any).error = null;
        parserStream._parser.resume();
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

    void this.queue.add(async () => {
      try {
        await this.parseSitemap(url);
      } catch (e) {
        logger.warn(
          "Sitemap parse failed",
          { url, ...formatErr(e) },
          "sitemap",
        );
      }
    });
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
}
