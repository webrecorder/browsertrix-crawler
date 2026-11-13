import { getSurt, WARCParser, WARCRecord } from "warcio";
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
import Redis from "ioredis";
import { tsToDate } from "@webrecorder/wabac";
import { CrawlStatus, ExitCodes } from "./util/constants.js";

const decoder = new TextDecoder();

export class TextCompareCrawler extends ReplayCrawler {
  incKey = "";
  nextWACZKey = "";

  override async addWACZ(url: string, name: string): Promise<void> {
    await this.crawlState.redis.rpush(this.nextWACZKey, url + " " + name);
  }

  override async initCrawlState() {
    const res = await super.initCrawlState();

    this.incKey = `${this.crawlState.crawlId}:qa:count`;
    this.nextWACZKey = `${this.crawlState.crawlId}:qa:q`;

    return res;
  }

  protected override async _addInitialSeeds() {
    await super._addInitialSeeds();

    while (true) {
      const nextWACZ = await this.crawlState.redis.lpop(this.nextWACZKey);
      if (!nextWACZ) {
        break;
      }
      const [url, name] = nextWACZ.split(" ");
      await this.processWACZ(url, name);
    }
  }

  async getFinalCrawlState(): Promise<[ExitCodes, CrawlStatus]> {
    const canceled = await this.crawlState.isCrawlCanceled();
    if (canceled) {
      return [ExitCodes.Success, "canceled"];
    }

    const hasNextWACZ = await this.crawlState.redis.llen(this.nextWACZKey);
    if (hasNextWACZ) {
      return [ExitCodes.GenericError, "interrupted"];
    }

    const count = parseInt(
      (await this.crawlState.redis.get(this.incKey)) || "0",
    );

    if (count > 0) {
      return [ExitCodes.Success, "done"];
    }

    logger.info("No text resources QAd, failing");
    return [ExitCodes.Failed, "failed"];
  }

  async processWACZ(waczurl: string, name: string) {
    const loader = new WACZLoader(waczurl);
    await loader.init();

    const textWARCs = [];

    for await (const { filename } of loader.iterFiles("archive/")) {
      if (filename.indexOf("-text-") > 0) {
        textWARCs.push(filename);
      }
    }

    const index = await loader.loadFile("indexes/index.cdx.gz", {
      unzip: true,
    });

    if (!index) {
      return;
    }

    logger.debug("Processing WACZ: " + waczurl);

    const redis = this.crawlState.redis;

    const cdxKey = `wacz:${name}:cdx`;

    let cdxCount = 0;

    for await (const buff of index.iterLines()) {
      //if (buff.startsWith("urn:text:")) {
      //await redis.rpush(`wacz:${name}:urntext`, buff);
      if (buff.startsWith("urn:")) {
        continue;
      }

      await redis.zadd(cdxKey, 0, buff);

      if (cdxCount++ % 100 === 0) {
        logger.debug("Parsing CDX lines", { cdxCount });
      }
    }

    let warcCount = 0;

    for (const filename of textWARCs) {
      try {
        warcCount++;
        logger.debug(`Processing WARC ${warcCount} of ${textWARCs.length}`);
        const textWARCReader = await loader.loadFile(filename);
        if (!textWARCReader) {
          continue;
        }
        const parser = new WARCParser(textWARCReader);

        for await (const textRecord of parser) {
          try {
            await this.processTextRecord(textRecord, cdxKey, loader, redis);
          } catch (e) {
            console.error(e);
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    await redis.del(cdxKey);
  }

  async processTextRecord(
    textRecord: WARCRecord,
    cdxKey: string,
    loader: WACZLoader,
    redis: Redis,
  ) {
    if (textRecord.warcType !== "resource") {
      return false;
    }

    const textUrl = textRecord.warcTargetURI;
    if (!textUrl?.startsWith("urn:text:")) {
      return false;
    }

    // DOM-extracted text
    const domText = decoder.decode(await textRecord.readFully());

    const url = textUrl.slice("urn:text:".length);
    const surt = getSurt(url);

    const results = await redis.zrange(
      cdxKey,
      "[" + surt,
      "+",
      "BYLEX",
      "LIMIT",
      0,
      1,
    );

    if (!results.length) {
      return false;
    }

    const cdx = results[0];

    const rawCDX = JSON.parse(cdx.slice(cdx.indexOf(" {")));
    const ts = cdx.split(" ", 2)[1];

    if (
      rawCDX.status !== "200" ||
      !["text/html", "text/xhtml"].includes(rawCDX.mime)
    ) {
      return false;
    }

    const rawResult = await this.loadWARCRecordText(
      loader,
      rawCDX.filename,
      rawCDX.offset,
      rawCDX.length,
    );

    if (!rawResult) {
      logger.debug("No RAW result", {
        filename: rawCDX.filename,
        offset: rawCDX.offset,
        length: rawCDX.length,
      });
      return;
    }

    const { recordID, text: rawHTMLText } = rawResult;

    const compareResult = await this.compareHTMLRawText(domText, rawHTMLText);

    if (!compareResult) {
      logger.debug("No Compare result", {
        domLen: domText.length,
        rawLen: rawHTMLText.length,
      });
      return;
    }

    const pageState = new PageState({
      url,
      seedId: 0,
      extraHops: 0,
      depth: 0,
    });
    pageState.ts = tsToDate(ts);

    const comparison: ComparisonPageState = pageState as ComparisonPageState;
    comparison.comparison = {};

    const { rawText, matchPercent } = compareResult;

    comparison.comparison.rawTextMatch = matchPercent;

    if (rawHTMLText) {
      this.processClues(rawText, url, comparison);
    }

    // save to WARC if text-from-response is set
    if (this.textWriter && this.params.text.includes("text-from-response")) {
      this.textWriter.writeNewResourceRecord(
        {
          buffer: new TextEncoder().encode(rawText),
          resourceType: "text-from-response",
          contentType: "text/plain",
          url: url,
          date: new Date(),
          refersTo: recordID,
        },
        { type: "text-from-response", url: url },
        "replay",
      );
      logger.info(
        "Wrote raw text to WARC",
        { url, length: rawText.length, refersTo: recordID },
        "replay",
      );
    }

    const count = await redis.incr(this.incKey);
    if (count % 100 === 0) {
      logger.info("Pages processed", { count });
    }

    await this.writePage(comparison);
  }

  override async createSitemapper(): Promise<SitemapReader | null> {
    return null;
  }

  async loadWARCRecordText(
    loader: WACZLoader,
    filename: string,
    offset: string,
    length: string,
  ): Promise<{ recordID: string; text: string } | null> {
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
      return null;
    }
    const buff = await record.readFully();
    if (buff) {
      return {
        recordID: record.warcHeader("WARC-Record-ID") || "",
        text: decoder.decode(buff),
      };
    }
    return null;
  }

  async compareHTMLRawText(origText: string, htmlRawText: string) {
    let rawText = "";
    const dom = new JSDOM(htmlRawText);
    try {
      rawText = extractTextFromDOM(dom.window.document);
    } finally {
      dom.window.close();
    }

    const dist = levenshtein(origText, rawText);
    const maxLen = Math.max(origText.length, rawText.length);

    let matchPercent = 1.0;
    if (maxLen > 0) {
      matchPercent = (maxLen - dist) / maxLen;
    }

    return { rawText, matchPercent };
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
      logger.debug(
        "CSR clues detected",
        {
          url,
          categories: categoryCounts,
          clues: clueCounts,
        },
        "replay",
      );
    } else {
      logger.debug("No CSR clues detected", { url }, "replay");
    }
  }

  async launchBrowser() {
    //nop
  }
}
