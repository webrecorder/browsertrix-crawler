import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";

const SITEMAP_CONCURRENCY = 5;

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

  q: PQueue;

  seenSitemapSet: Set<string>;
  pending: Set<string>;

  count = 0;
  limit: number;

  constructor(opts: SitemapOpts) {
    super();
    this.headers = opts.headers;

    this.q = new PQueue({ concurrency: SITEMAP_CONCURRENCY });

    this.fromDate = opts.fromDate;
    this.toDate = opts.toDate;

    this.seenSitemapSet = new Set<string>();

    this.limit = opts.limit || 0;

    this.pending = new Set<string>();
  }

  async maybeEnd() {
    if (!this.pending.size) {
      await this.q.onIdle();
    }
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
      return;
    }
    const readableNodeStream = Readable.fromWeb(
      resp.body as ReadableStream<Uint8Array>,
    );
    this.initSaxParser(url, readableNodeStream);
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

    let otherTags = 0;

    parserStream.on("end", async () => {
      this.pending.delete(url);
      if (!this.pending.size) {
        await this.q.onIdle();
        this.emit("end");
      }
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
        this.pending.delete(url);
        return;
      }
      logger.warn("Sitemap error parsing XML", { err }, "sitemap");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parserStream._parser as any).error = null;
      parserStream._parser.resume();
    });

    sourceStream.pipe(parserStream);
  }

  atLimit(): boolean {
    return Boolean(this.limit && this.count >= this.limit);
  }

  addNewSitemap(url: string) {
    if (this.seenSitemapSet.has(url)) {
      return;
    }

    if (this.atLimit()) {
      return;
    }

    this.q.add(async () => {
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

    this.count++;
  }

  getSitemapsQueued() {
    return this.q.size;
  }
}
