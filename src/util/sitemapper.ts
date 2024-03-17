import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

import sax from "sax";
import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";

export class SitemapReader extends EventEmitter {
  headers?: Record<string, string>;

  fromDate?: Date;
  toDate?: Date;

  q: PQueue;
  active = 0;

  constructor(
    headers?: Record<string, string>,
    fromDate?: Date,
    toDate?: Date,
  ) {
    super();
    this.headers = headers;
    this.q = new PQueue({ concurrency: 1 });

    this.fromDate = fromDate;
    this.toDate = toDate;
  }
  async parseSitemap(url: string): Promise<void> {
    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      throw new Error(`invalid_response: ${resp.status}`);
    }
    const readableNodeStream = Readable.fromWeb(
      resp.body as ReadableStream<Uint8Array>,
    );
    return await this.initSaxParser(readableNodeStream);
  }

  async initSaxParser(sourceStream: Readable) {
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

    this.active++;

    //let done = false;

    //let nextEntry : (value: SitemapUrl | PromiseLike<SitemapUrl>) => void;
    //let p = new Promise<SitemapUrl>(resolve => nextEntry = resolve);

    parserStream.on("end", () => {
      this.maybeEnded();
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
            const url = currUrl;
            this.q.add(async () => {
              const nested = new SitemapReader(
                this.headers,
                this.fromDate,
                this.toDate,
              );
              nested.on("url", (data) => {
                this.emit("url", data);
              });
              nested.on("end", () => {
                this.maybeEnded();
              });
              this.active++;
              try {
                await nested.parseSitemap(url);
              } catch (e) {
                logger.warn(
                  "Sitemap parse failed",
                  { url, ...formatErr(e) },
                  "sitemap",
                );
                this.active--;
              }
            });
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
        console.warn("text in url, ignoring");
      } else if (parsingUrlset) {
        console.warn("text in urlset, ignoring");
      } else if (parsingSitemap) {
        console.warn("text in sitemap, ignoring");
      } else if (parsingSitemapIndex) {
        console.warn("text in sitemapindex, ignoring");
      }
    });

    parserStream.on("error", (err: Error) => {
      console.log("err", err);
      throw err;
    });

    sourceStream.pipe(parserStream);

    await this.q.onIdle();
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

  maybeEnded() {
    this.active--;
    if (this.active <= 0) {
      this.emit("end");
    }
  }
}
