import { getSurt, WARCParser } from "warcio";
import {
  ComparisonData,
  ComparisonPageState,
  ReplayCrawler,
} from "./replaycrawler.js";
import { SitemapReader } from "./util/sitemapper.js";
//import { logger } from "./util/logger";
import { WACZLoader } from "./util/wacz.js";
import levenshtein from "js-levenshtein";
import { extractTextFromDOM } from "./util/textextract.js";
import { JSDOM } from "jsdom";
import { logger } from "./util/logger.js";
import { CSR_CLUES } from "./util/clientSideRenderingClues.js";
import { PageState } from "./util/state.js";
//import { WorkerState } from "./util/worker";

const decoder = new TextDecoder();

export class TextCompareCrawler extends ReplayCrawler {
  override async addWACZ(url: string, name: string): Promise<void> {
    await this.crawlState.addQAWACZ(url + " " + name);
  }

  protected override async _addInitialSeeds() {
    await super._addInitialSeeds();

    while (true) {
      const nextWACZ = await this.crawlState.nextQAWACZ();
      if (!nextWACZ) {
        break;
      }
      const [url, name] = nextWACZ.split(" ");
      await this.processWACZ(url, name);
    }
  }

  async processWACZ(waczurl: string, name: string) {
    const loader = new WACZLoader(waczurl);
    await loader.init();

    const index = await loader.loadFile("indexes/index.cdx.gz", {
      unzip: true,
    });

    if (!index) {
      return;
    }

    const redis = this.crawlState.redis;

    for await (const buff of index.iterLines()) {
      if (buff.startsWith("urn:text:")) {
        await redis.rpush(`wacz:${name}:urntext`, buff);
      } else if (!buff.startsWith("urn:")) {
        await redis.zadd(`wacz:${name}:cdx`, 0, buff);
      }
    }

    while (true) {
      try {
        const pageWithText = await redis.lpop(`wacz:${name}:urntext`);
        if (!pageWithText) {
          break;
        }

        const domCDX = JSON.parse(
          pageWithText.slice(pageWithText.indexOf(" {")),
        );
        const surt = getSurt(domCDX.url.slice("urn:text:".length));

        const results = await redis.zrange(
          `wacz:${name}:cdx`,
          "[" + surt,
          "+",
          "BYLEX",
          "LIMIT",
          0,
          1,
        );
        if (!results.length) {
          continue;
        }

        const rawCDX = JSON.parse(results[0].slice(results[0].indexOf(" {")));
        if (
          rawCDX.status !== "200" ||
          !["text/html", "text/xhtml"].includes(rawCDX.mime)
        ) {
          continue;
        }

        const domText = await this.loadWARCRecordText(
          loader,
          domCDX.filename,
          domCDX.offset,
          domCDX.length,
        );
        const rawHTMLText = await this.loadWARCRecordText(
          loader,
          rawCDX.filename,
          rawCDX.offset,
          rawCDX.length,
        );

        const pageState = new PageState({
          url: waczurl,
          seedId: 0,
          extraHops: 0,
          depth: 0,
        });
        const comparison: ComparisonPageState =
          pageState as ComparisonPageState;
        comparison.comparison = {};

        const match = await this.compareHTMLRawText(domText, rawHTMLText);

        comparison.comparison.rawTextMatch = match;

        if (rawHTMLText) {
          this.processClues(rawHTMLText, waczurl, comparison);
        }

        //console.log("dom-text", domCDX.offset, domCDX.length, domCDX.filename);
        //console.log("raw-text", rawCDX.offset, rawCDX.length, rawCDX.filename);

        await this.writePage(comparison);
      } catch (e) {
        console.error(e);
      }
    }
  }

  override async createSitemapper(): Promise<SitemapReader | null> {
    return null;
  }

  override pageEntryForRedis(
    entry: Record<string, string | number | boolean | object>,
    state: ComparisonPageState,
  ) {
    entry.comparison = state.comparison;
    console.log(entry.comparison);
    return entry;
  }

  async loadWARCRecordText(
    loader: WACZLoader,
    filename: string,
    offset: string,
    length: string,
  ): Promise<string | null> {
    const reader = await loader.loadFile("archive/" + filename, {
      offset: parseInt(offset),
      length: parseInt(length),
    });

    if (!reader) {
      return null;
    }

    const parser = new WARCParser(reader);
    const record = await parser.parse();

    if (!record) {
      console.log("no record");
      return null;
    }
    const buff = await record.readFully();
    if (buff) {
      return decoder.decode(buff);
    }
    console.log("no buffer");
    return null;
  }

  async compareHTMLRawText(
    origText: string | null,
    htmlRawText: string | null,
  ) {
    if (origText === null || htmlRawText === null) {
      console.log(!origText, !htmlRawText);
      return;
    }

    let newText = "";
    const dom = new JSDOM(htmlRawText);
    try {
      newText = extractTextFromDOM(dom.window.document);
    } finally {
      dom.window.close();
    }

    const dist = levenshtein(origText, newText);
    const maxLen = Math.max(origText.length, newText.length);

    let matchPercent = 1.0;
    if (maxLen > 0) {
      matchPercent = (maxLen - dist) / maxLen;
    }

    return matchPercent;
  }

  processClues(htmlContent: string, url: string, pageInfo: ComparisonData) {
    const clueCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const clue of CSR_CLUES) {
      const regex = new RegExp(clue.pattern, "gi");
      const matches = htmlContent.match(regex);

      if (matches && matches.length > 0) {
        // count by clue name
        clueCounts[clue.name] = matches.length;

        // count by category (sum of all patterns in category)
        categoryCounts[clue.category] =
          (categoryCounts[clue.category] || 0) + matches.length;

        logger.debug(
          "CSR clue detected",
          {
            pattern: clue.name,
            category: clue.category,
            url,
            count: matches.length,
          },
          "replay",
        );
      }
    }

    // add clue counts to pageInfo
    pageInfo.comparison["csrClues"] = {
      clues: clueCounts,
      categories: categoryCounts,
    };
    if (Object.keys(clueCounts).length > 0) {
      logger.info(
        "CSR clues detected",
        {
          url,
          categories: categoryCounts,
          clues: clueCounts,
        },
        "replay",
      );
    } else {
      logger.info("No CSR clues detected", { url }, "replay");
    }
  }

  //   async processWACZ(url: string) {
  //     const loader = new WACZLoader(url);
  //     await loader.init();

  //     let count = 0;

  //     const pagesReader = await loader.loadFile("pages/pages.jsonl");

  //     if (pagesReader) {
  //       for await (const buff of pagesReader.iterLines()) {
  //         await this.processPage(loader, buff, count++);
  //         if (this.limitHit) {
  //           break;
  //         }
  //       }
  //     }

  //     try {
  //       const extraPagesReader = await loader.loadFile("pages/extraPages.jsonl");

  //       if (extraPagesReader) {
  //         for await (const buff of extraPagesReader.iterLines()) {
  //           await this.processPage(loader, buff, count++);
  //           if (this.limitHit) {
  //             break;
  //           }
  //         }
  //       }
  //     } catch (e) {
  //       logger.warn(
  //         "No extraPages.jsonl found or error reading extraPages, ignoring",
  //         e,
  //         "replay",
  //       );
  //     }
  //   }
}
