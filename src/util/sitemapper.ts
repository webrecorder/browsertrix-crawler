import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";

const SITEMAP_CONCURRENCY = 5;

export type SitemapOpts = {
  headers?: Record<string, string>;
  q?: PQueue;
  seenSitemapSet?: Set<string>;

  fromDate?: Date;
  toDate?: Date;
};

export class SitemapReader extends EventEmitter {
  headers?: Record<string, string>;

  fromDate?: Date;
  toDate?: Date;

  q: PQueue;

  seenSitemapSet: Set<string>;

  isRoot = false;

  constructor(opts: SitemapOpts) {
    super();
    this.headers = opts.headers;
    this.isRoot = !opts.q;
    this.q = opts.q || new PQueue({ concurrency: SITEMAP_CONCURRENCY });

    this.fromDate = opts.fromDate;
    this.toDate = opts.toDate;
    this.seenSitemapSet = opts.seenSitemapSet || new Set<string>();
  }
  async parseSitemap(url: string): Promise<void> {
    this.seenSitemapSet.add(url);

    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      logger.error(
        "Sitemap parse failed",
        { url, status: resp.status },
        "sitemap",
      );
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
      }
    });

    parserStream.on("closetag", (tagName: string) => {
      switch (tagName) {
        // Single Sitemap
        case "url":
          this.emitEntry(currUrl, lastmod);
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
      } else if (parsingUrl) {
        //console.warn("text in url, ignoring");
      } else if (parsingUrlset) {
        console.warn("text in urlset, ignoring");
      } else if (parsingSitemap) {
        //console.warn("text in sitemap, ignoring");
      } else if (parsingSitemapIndex) {
        console.warn("text in sitemapindex, ignoring");
      }
    });

    parserStream.on("error", (err: Error) => {
      logger.warn("Sitemap error parsing XML", { err }, "sitemap");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parserStream._parser as any).error = null;
      parserStream._parser.resume();
    });

    sourceStream.pipe(parserStream);
  }

  addNewSitemap(url: string) {
    if (this.seenSitemapSet.has(url)) {
      return;
    }

    this.q.add(async () => {
      const nested = new SitemapReader({
        headers: this.headers,
        fromDate: this.fromDate,
        toDate: this.toDate,
        seenSitemapSet: this.seenSitemapSet,
        q: this.q,
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
        nested.on("end", () => resolve());
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

    this.emit("url", { url, lastmod });
  }

  getSitemapsQueued() {
    return this.q.size;
  }
}
