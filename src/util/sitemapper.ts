import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";

const SITEMAP_CONCURRENCY = 5;

export type Counter = {
  value: number;
};

export type SitemapOpts = {
  headers?: Record<string, string>;
  q?: PQueue;
  seenSitemapSet?: Set<string>;

  fromDate?: Date;
  toDate?: Date;
  counter?: Counter;
  limit?: number;
};

export class SitemapReader extends EventEmitter {
  headers?: Record<string, string>;

  fromDate?: Date;
  toDate?: Date;

  q: PQueue;

  seenSitemapSet: Set<string>;

  counter: Counter;
  limit: number;

  isRoot = false;

  constructor(opts: SitemapOpts) {
    super();
    this.headers = opts.headers;

    this.isRoot = !opts.q;
    this.q = opts.q || new PQueue({ concurrency: SITEMAP_CONCURRENCY });

    this.fromDate = opts.fromDate;
    this.toDate = opts.toDate;

    this.seenSitemapSet = opts.seenSitemapSet || new Set<string>();

    this.counter = opts.counter || { value: 0 };
    this.limit = opts.limit || 0;
  }
  async parseSitemap(url: string): Promise<void> {
    this.seenSitemapSet.add(url);

    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      if (!this.atLimit()) {
        logger.error(
          "Sitemap parse failed",
          { url, status: resp.status },
          "sitemap",
        );
      }
      this.emit("end");
      return;
    }
    const readableNodeStream = Readable.fromWeb(
      resp.body as ReadableStream<Uint8Array>,
    );
    this.initSaxParser(readableNodeStream);
  }

  initSaxParser(sourceStream: Readable) {
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

    let otherTags = 0;

    parserStream.on("end", async () => {
      if (this.isRoot) {
        await this.q.onIdle();
      }
      this.emit("end");
    });

    parserStream.on("opentag", (node: sax.Tag) => {
      //console.log("open", node);
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
            this.addNewSitemap(currUrl);
          }
          parsingSitemap = false;
          break;

        default:
          otherTags--;
      }
    });

    parserStream.on("text", (text: string) => {
      //console.log("text", text);
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
          console.warn("text in url, ignoring");
        } else if (parsingUrlset) {
          console.warn("text in urlset, ignoring");
        } else if (parsingSitemap) {
          console.warn("text in sitemap, ignoring");
        } else if (parsingSitemapIndex) {
          console.warn("text in sitemapindex, ignoring");
        }
      }
    });

    parserStream.on("error", (err: Error) => {
      if (this.atLimit()) {
        return;
      }
      logger.warn("Sitemap error parsing XML", { err }, "sitemap");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parserStream._parser as any).error = null;
      parserStream._parser.resume();
    });

    sourceStream.pipe(parserStream);
  }

  atLimit() {
    return this.limit && this.counter.value >= this.limit;
  }

  addNewSitemap(url: string) {
    if (this.seenSitemapSet.has(url)) {
      return;
    }

    if (this.atLimit()) {
      return;
    }

    this.q.add(async () => {
      const nested = new SitemapReader({
        headers: this.headers,
        fromDate: this.fromDate,
        toDate: this.toDate,
        seenSitemapSet: this.seenSitemapSet,
        q: this.q,
        counter: this.counter,
        limit: this.limit,
      });

      nested.on("url", (data) => {
        this.emit("url", data);
      });

      try {
        await nested.parseSitemap(url);
      } catch (e) {
        logger.warn(
          "Sitemap parse failed",
          { url, ...formatErr(e) },
          "sitemap",
        );
      }

      return new Promise<void>((resolve) => {
        nested.on("end", () => {
          resolve();
          if (this.atLimit()) {
            this.emit("end");
          }
        });
      });
    });
  }

  emitEntry(url: string | null, lastmod: Date | null) {
    if (!url) {
      return;
    }

    if (lastmod) {
      if (this.fromDate && lastmod < this.fromDate) {
        return;
      }

      if (this.toDate && lastmod > this.toDate) {
        return;
      }
    }

    if (this.atLimit()) {
      this.q.clear();
      return;
    }

    this.emit("url", { url, lastmod });

    this.counter.value++;
  }

  getSitemapsQueued() {
    return this.q.size;
  }
}
