//import { createStream } from 'sax';
import sax from "sax";
//import PQueue from "p-queue";
import { Readable } from "stream";
import { ReadableStream } from "node:stream/web";
import EventEmitter from "events";

// type SitemapUrl = {
//   url: string;
//   lastmod?: Date | null;
// }

export class SitemapReader extends EventEmitter {
  headers?: Record<string, string>;
  //q: PQueue;

  constructor(headers?: Record<string, string>) {
    super();
    this.headers = headers;
    //this.q = new PQueue({ concurrency: 1 });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async parseSitemap(url: string, loadFrom?: Date): Promise<void> {
    console.log(url, this.headers);
    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      console.log(resp.status, await resp.text());
      throw new Error("invalid_response");
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let parsingIndex = false;

    let parsingUrlset = false;
    let parsingUrl = false;
    let parsingLoc = false;
    let parsingLastmod = false;

    let currUrl: string | null;
    let lastmod: Date | null = null;

    //let done = false;

    //let nextEntry : (value: SitemapUrl | PromiseLike<SitemapUrl>) => void;
    //let p = new Promise<SitemapUrl>(resolve => nextEntry = resolve);

    parserStream.on("end", () => {
      this.emit("done");
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
          parsingIndex = true;
          break;
      }
    });

    parserStream.on("closetag", (tagName: string) => {
      switch (tagName) {
        // Single Sitemap
        case "url":
          if (currUrl) {
            this.emit("url", { url: currUrl, lastmod });
            //nextEntry({url: currUrl, lastmod});
            //p = new Promise<SitemapUrl>(resolve => nextEntry = resolve);
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
          parsingIndex = false;
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
      }
    });

    parserStream.on("error", (err: Error) => {
      console.log("err", err);
      throw err;
    });

    sourceStream.pipe(parserStream);

    // while (!done) {
    //   yield await p;
    // }
  }
}

// class SitemapParser {
//   private visitedSitemaps: { [key: string]: boolean } = {};

//   constructor(
//     private urlCb: (text: string | null, url: string, err?: Error) => void,
//     private sitemapCb: (text: string) => void,
//     private options?: any
//   ) {}

//   private async _download(url: string, parserStream: any): Promise<void> {
//     const errorCb = (err: Error) => {
//       this.urlCb(null, url, err);
//       throw err;
//     };

//     const response = await fetch(url);
//     if (!response.ok) {
//       throw new Error(`Error fetching URL: ${url}, Status: ${response.status}`);
//     }

//     const bodyStream = response.body;
//     const finalStream = new stream.PassThrough();
//     bodyStream.pipe(finalStream);

//     finalStream.on('error', errorCb);
//   }

//   public async parse(url: string): Promise<void> {
//     let isUrlSet = false;
//     let isSitemapIndex = false;
//     let inLoc = false;

//     this.visitedSitemaps[url] = true;

//     const parserStream = sax.createStream(false, { trim: true, normalize: true, lowercase: true });

//     parserStream.on('opentag', (node: any) => {
//       inLoc = node.name === 'loc';
//       isUrlSet = true if node.name === 'urlset';
//       isSitemapIndex = true if node.name === 'sitemapindex';
//     });

//     parserStream.on('error', (err: Error) => {
//       this.urlCb(null, url, err);
//       throw err;
//     });

//     parserStream.on('text', (text: string) => {
//       text = urlParser.resolve(url, text);
//       if (inLoc) {
//         if (isUrlSet) {
//           this.urlCb(text, url);
//         } else if (isSitemapIndex) {
//           if (this.visitedSitemaps[text]) {
//             console.error(`Already parsed sitemap: ${text}`);
//           } else {
//             this.sitemapCb(text);
//           }
//         }
//       }
//     });

//     await this._download(url, parserStream);
//   }
// }

// const queue = new PQueue({ concurrency: 4 });

// export const parseSitemap = async (
//   url: string,
//   urlCb: (text: string | null, url: string, err?: Error) => void,
//   sitemapCb: (text: string) => void,
//   options?: any
// ): Promise<void> => {
//   const parser = new SitemapParser(urlCb, sitemapCb, options);
//   await queue.add(() => parser.parse(url));
// };

// export const parseSitemaps = async (
//   urls: string | string[],
//   urlCb: (text: string | null, url: string, err?: Error) => void,
//   sitemapTest: (sitemap: string) => boolean,
//   options?: any
// ): Promise<string[]> => {
//   urls = Array.isArray(urls) ? urls : [urls];

//   const sitemapCb = (sitemap: string) => {
//     const shouldPush = sitemapTest ? sitemapTest(sitemap) : true;
//     queue.add(() => parseSitemap(sitemap, urlCb, () => {})) if shouldPush;
//   };

//   const parser = new SitemapParser(urlCb, sitemapCb, options);

//   await Promise.all(urls.map((url) => queue.add(() => parser.parse(url))));

//   return Object.keys(parser.visitedSitemaps);
// };

// export const sitemapsInRobots = async (url: string): Promise<string[]> => {
//   try {
//     const response = await fetch(url);
//     if (!response.ok) {
//       throw new Error(`Error fetching URL: ${url}, Status: ${response.status}`);
//     }

//     const body = await response.text();
//     const matches: string[] = [];
//     body.replace(/^Sitemap:\s?([^\s]+)$/igm, (m, p1) => {
//       matches.push(p1);
//     });
//     return matches;
//   } catch (err) {
//     throw err;
//   }
// };
