// import * as sax from 'sax';
// //import * as PQueue from 'p-queue';
// import { Readable } from 'stream';
// import { ReadableStream } from 'node:stream/web';

// class SitemapReader {
//   async parseSitemap(url: string) {
//     const resp = await fetch(url);
//     const readableNodeStream = Readable.fromWeb(resp.body as ReadableStream<Uint8Array>);
//   }

//   initSaxParser(sourceStream : Readable) {
//     const parserStream = sax.createStream(false, { trim: true, normalize: true, lowercase: true });

//     let parsingIndex = false;

//     let parsingUrlset = false;
//     let parsingUrl = false;
//     let parsingLoc = false;
//     let parsingLastmod = false;

//     let currUrl = null;
//     let lastmod : Date = null;

//     parserStream.on('opentag', (node: sax.Tag) => {
//       switch (node.name) {
//         case "sitemapindex":
//           parsingIndex = true;
//           break;

//         case "urlset":
//           parsingUrlset = true;
//           break;

//         case "url":
//           parsingUrl = true;
//           break;

//         case "loc":
//           parsingLoc = true;
//           break;

//         case "lastmod":
//           parsingLastmod = true;
//           break;
//       }
//     });

//     parserStream.on("closetag", (node: sax.Tag) => {
//       switch (node.name) {
//         case "sitemapindex":
//           parsingIndex = false;
//           break;

//         case "urlset":
//           parsingUrlset = false;
//           break;

//         case "url":
//           parsingUrl = false;

//           break;

//         case "loc":
//           parsingLoc = false;
//           break;

//         case "lastmod":
//           parsingLastmod = false;
//           break;
//       }
//     });

//     parserStream.on('text', (text: string) => {
//       if (parsingLoc) {
//         currUrl = text;
//       } else if (parsingLastmod) {
//         lastmod = new Date(text);
//       }
//     });

//     parserStream.on('error', (err: Error) => {
//       //      this.urlCb(null, url, err);
//             throw err;
//           });
//   }
// }

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
