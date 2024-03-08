import { Page, Protocol } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { logger } from "./util/logger.js";
import { WorkerOpts, WorkerState } from "./util/worker.js";
import { PageState } from "./util/state.js";
import { PageInfoRecord, PageInfoValue, Recorder } from "./util/recorder.js";

import fsp from "fs/promises";
import path from "path";

// @ts-expect-error wabac.js
import { ZipRangeReader } from "@webrecorder/wabac/src/wacz/ziprangereader.js";
// @ts-expect-error wabac.js
import { createLoader } from "@webrecorder/wabac/src/blockloaders.js";

import { AsyncIterReader } from "warcio";
import { WARCResourceWriter } from "./util/warcresourcewriter.js";
import { parseArgs } from "./util/argParser.js";

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

import levenshtein from "js-levenshtein";
import { MAX_URL_LENGTH } from "./util/reqresp.js";
import { openAsBlob } from "fs";

const REPLAY_PREFIX = "http://localhost:9990/replay/w/replay/";

//import { openAsBlob } from "node:fs";

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
};

type ComparisonData = {
  comparison: {
    screenshotMatch?: number;
    textMatch?: number;
    resourceCounts: {
      crawlGood?: number;
      crawlBad?: number;
      replayGood?: number;
      replayBad?: number;
    };
  };
};

type ReplayPageInfoRecord = PageInfoRecord & ComparisonData;

type ComparisonPageState = PageState & ComparisonData;

// ============================================================================
export class ReplayCrawler extends Crawler {
  replayServer: ReplayServer;
  qaSource: string;

  pageInfos: Map<Page, ReplayPageInfoRecord>;

  reloadTimeouts: WeakMap<Page, NodeJS.Timeout>;

  constructor() {
    super();
    this.recording = false;
    if (!this.params.qaSource) {
      throw new Error("Missing QA source");
    }
    this.qaSource = this.params.qaSource;
    this.replayServer = new ReplayServer(this.qaSource);

    this.pageInfos = new Map<Page, ReplayPageInfoRecord>();

    // skip text from first two frames, as they are RWP boilerplate
    this.skipTextDocs = 2;

    this.params.scopedSeeds = [];

    this.params.screenshot = ["view"];
    this.params.text = ["to-warc"];

    this.reloadTimeouts = new WeakMap<Page, NodeJS.Timeout>();
  }

  protected parseArgs() {
    return parseArgs(process.argv, true);
  }

  async setupPage(opts: WorkerState) {
    await super.setupPage(opts);
    const { page, cdp } = opts;

    if (!this.qaSource) {
      throw new Error("Missing QA source");
    }

    await cdp.send("Network.enable");

    cdp.on("Network.responseReceived", async (params) =>
      this.handlePageResourceResponse(params, page),
    );

    cdp.on("Network.requestWillBeSent", (params) =>
      this.handleRequestWillBeSent(params, page),
    );

    await page.goto(this.replayServer.homePage);

    while (page.frames().length < 2) {
      //console.log("Frames: " + page.frames().length);
      await sleep(5);
    }

    const frame = page.frames()[1];
    //console.log(frame.url());

    await frame.evaluate(() => {
      return navigator.serviceWorker.ready;
    });
  }

  protected async _addInitialSeeds() {
    // this.params.scopedSeeds = [
    //   new ScopedSeed({url: "https://replay.example.com/", scopeType: "page", depth: 1, include: [] })
    // ];

    await this.loadPages(this.qaSource);
  }

  isInScope() {
    return true;
  }

  async loadPages(url: string) {
    if (url.endsWith(".wacz")) {
      await this.loadPagesForWACZ(url);
    } else if (url.endsWith(".json")) {
      const resp = await fetch(url);
      const json = await resp.json();

      for (const entry of json.resources) {
        if (entry.path) {
          await this.loadPages(entry.path);
        }
      }
    } else {
      logger.warn("Unknown replay source", { url }, "replay");
    }
  }

  async loadPagesForWACZ(url: string) {
    const loader = new WACZLoader(url);
    await loader.init();

    let count = 0;

    const pagesReader = await loader.loadFile("pages/pages.jsonl");

    if (pagesReader) {
      for await (const buff of pagesReader.iterLines()) {
        await this.addPage(buff, count++);
        if (this.limitHit) {
          break;
        }
      }
    }

    const extraPagesReader = await loader.loadFile("pages/extraPages.jsonl");

    if (extraPagesReader) {
      for await (const buff of extraPagesReader.iterLines()) {
        await this.addPage(buff, count++);
        if (this.limitHit) {
          break;
        }
      }
    }
  }

  async addPage(page: string, depth: number) {
    let pageData: ReplayPage;

    if (!page.length) {
      return;
    }

    try {
      pageData = JSON.parse(page);
    } catch (e) {
      console.log(page, e);
      return;
    }

    const { url, ts, id } = pageData;
    if (!url) {
      return;
    }

    await this.queueUrl(0, url, depth, 0, {}, ts, id);
  }

  handleRequestWillBeSent(
    params: Protocol.Network.RequestWillBeSentEvent,
    page: Page,
  ) {
    // only handling redirect here, committing last response in redirect chain
    const { redirectResponse, type } = params;
    if (redirectResponse) {
      const { url, status, mimeType } = redirectResponse;
      this.addPageResource(url, page, { status, mime: mimeType, type });
    }
  }

  async handlePageResourceResponse(
    params: Protocol.Network.ResponseReceivedEvent,
    page: Page,
  ) {
    const { response } = params;
    const { url, status } = response;
    if (!url.startsWith(REPLAY_PREFIX)) {
      if (url.startsWith("http://localhost:9990/replay/?source=")) {
        const { mimeType, fromServiceWorker } = response;
        if (
          !fromServiceWorker &&
          mimeType === "application/json" &&
          page.frames().length > 1
        ) {
          const frame = page.frames()[1];
          const timeoutid = setTimeout(() => {
            logger.warn("Reloading RWP Frame, not inited", { url }, "replay");
            frame.evaluate("window.location.reload();");
          }, 10000);
          this.reloadTimeouts.set(page, timeoutid);
        } else if (fromServiceWorker && mimeType !== "application/json") {
          const timeoutid = this.reloadTimeouts.get(page);
          if (timeoutid) {
            clearTimeout(timeoutid);
            this.reloadTimeouts.delete(page);
          }
        }
      }
      return;
    }

    const { type } = params;
    const { mimeType } = response;

    this.addPageResource(url, page, { status, mime: mimeType, type });
  }

  addPageResource(
    url: string,
    page: Page,
    { status, mime, type }: PageInfoValue,
  ) {
    const inx = url.indexOf("_/");
    if (inx <= 0) {
      return;
    }

    let replayUrl = url.slice(inx + 2, MAX_URL_LENGTH);

    const pageInfo = this.pageInfos.get(page);

    if (!pageInfo) {
      return;
    }

    if (replayUrl.startsWith("//")) {
      try {
        replayUrl = new URL(replayUrl, pageInfo.url).href;
      } catch (e) {
        //
      }
    }

    if (replayUrl.startsWith("http://") || replayUrl.startsWith("https://")) {
      pageInfo.urls[replayUrl] = { status, mime, type };
    }
  }

  async crawlPage(opts: WorkerState): Promise<void> {
    await this.writeStats();

    const { page, data } = opts;
    const { url, ts, pageid } = data;

    if (!ts) {
      return;
    }

    const date = ts ? new Date(ts) : undefined;

    const timestamp = date
      ? date.toISOString().slice(0, 19).replace(/[T:-]/g, "")
      : "";

    logger.info("Loading Replay", { url, timestamp }, "replay");

    const pageInfo = {
      pageid,
      urls: {},
      url,
      ts: date,
      comparison: { resourceCounts: {} },
      counts: { jsErrors: 0 },
    };
    this.pageInfos.set(page, pageInfo);

    await page.evaluate(
      (url, ts) => {
        const rwp = document.querySelector("replay-web-page");
        if (!rwp) {
          return;
        }
        const p = new Promise<void>((resolve) => {
          window.addEventListener(
            "message",
            (e) => {
              if (e.data && e.data.url && e.data.view) {
                resolve();
              }
            },
            { once: true },
          );
        });

        rwp.setAttribute("url", url);
        rwp.setAttribute("ts", ts ? ts : "");
        return p;
      },
      url,
      timestamp,
    );

    // optionally reload
    // await page.reload();

    await sleep(10);

    // console.log("Frames");
    // for (const frame of page.frames()) {
    //   console.log(`${frame.name()} - ${frame.url()}`);
    // }

    data.isHTMLPage = true;

    data.filteredFrames = page.frames().slice(2);

    try {
      data.title = await data.filteredFrames[0].title();
    } catch (e) {
      // ignore
    }

    data.favicon = await this.getFavicon(page, {});

    await this.doPostLoadActions(opts, true);

    await this.compareScreenshots(page, data, url, date);

    await this.compareText(page, data, url, date);

    await this.compareResources(page, data, url, date);

    await this.processPageInfo(page, data);
  }

  async compareScreenshots(
    page: Page,
    state: PageState,
    url: string,
    date?: Date,
  ) {
    const origScreenshot = await this.fetchOrigBinary(
      page,
      "view",
      url,
      date ? date.toISOString().replace(/[^\d]/g, "") : "",
    );
    const { pageid, screenshotView } = state;

    if (!origScreenshot || !origScreenshot.length) {
      logger.warn("Orig screenshot missing for comparison", { url }, "replay");
      return;
    }

    if (!screenshotView || !screenshotView.length) {
      logger.warn(
        "Replay screenshot missing for comparison",
        { url },
        "replay",
      );
      return;
    }

    const crawl = PNG.sync.read(origScreenshot);
    const replay = PNG.sync.read(screenshotView);

    const { width, height } = replay;
    const diff = new PNG({ width, height });

    const res = pixelmatch(crawl.data, replay.data, diff.data, width, height, {
      threshold: 0.1,
      alpha: 0,
    });

    const total = width * height;

    const matchPercent = (total - res) / total;

    logger.info(
      "Screenshot Diff",
      {
        url,
        diff: res,
        matchPercent,
      },
      "replay",
    );

    if (res && this.params.qaDebugImageDiff) {
      const dir = path.join(this.collDir, "screenshots", pageid || "unknown");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "crawl.png"), PNG.sync.write(crawl));
      await fsp.writeFile(path.join(dir, "replay.png"), PNG.sync.write(replay));
      await fsp.writeFile(path.join(dir, "diff.png"), PNG.sync.write(diff));
    }

    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      pageInfo.comparison.screenshotMatch = matchPercent;
    }
  }

  async compareText(page: Page, state: PageState, url: string, date?: Date) {
    const origText = await this.fetchOrigText(
      page,
      "text",
      url,
      date ? date.toISOString().replace(/[^\d]/g, "") : "",
    );
    const replayText = state.text;

    if (!origText || !replayText) {
      logger.warn(
        "Text missing for comparison",
        {
          url,
          origTextLen: origText?.length,
          replayTextLen: replayText?.length,
        },
        "replay",
      );
      return;
    }

    const dist = levenshtein(origText, replayText);
    const maxLen = Math.max(origText.length, replayText.length);
    const matchPercent = (maxLen - dist) / maxLen;
    logger.info("Levenshtein Dist", { url, dist, matchPercent, maxLen });
    // if (dist) {
    //   console.log(origText);
    //   console.log("------------")
    //   console.log(replayText);
    // }

    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      pageInfo.comparison.textMatch = matchPercent;
    }
  }

  async compareResources(
    page: Page,
    state: PageState,
    url: string,
    date?: Date,
  ) {
    const origResources = await this.fetchOrigText(
      page,
      "pageinfo",
      url,
      date ? date.toISOString().replace(/[^\d]/g, "") : "",
    );

    let origResData: PageInfoRecord | null;

    try {
      origResData = JSON.parse(origResources || "");
    } catch (e) {
      origResData = null;
    }

    const pageInfo: ReplayPageInfoRecord | undefined = this.pageInfos.get(page);

    if (!origResData) {
      logger.warn("Original resources missing / invalid", { url }, "replay");
      return;
    }

    if (!pageInfo) {
      logger.warn("Replay resources missing / invalid", { url }, "replay");
      return;
    }

    if (origResData.ts) {
      pageInfo.ts = origResData.ts;
    }

    const { resourceCounts } = pageInfo.comparison;

    const { good: crawlGood, bad: crawlBad } = this.countResources(origResData);
    const { good: replayGood, bad: replayBad } = this.countResources(pageInfo);

    resourceCounts.crawlGood = crawlGood;
    resourceCounts.crawlBad = crawlBad;
    resourceCounts.replayGood = replayGood;
    resourceCounts.replayBad = replayBad;

    logger.info("Resource counts", { url, ...resourceCounts }, "replay");

    // if (crawlGood !== replayGood) {
    //   console.log("*** ORIG");
    //   console.log(origResData);
    // }

    // //console.log(origResData);
    // console.log("*** REPLAY");
    // console.log(pageInfo);
  }

  countResources(info: PageInfoRecord) {
    let good = 0;
    let bad = 0;

    for (const [url, { status }] of Object.entries(info.urls)) {
      if (!url.startsWith("http")) {
        continue;
      }
      if (url.indexOf("__wb_method") !== -1) {
        continue;
      }
      if (status >= 400) {
        bad++;
      } else {
        good++;
      }
    }

    return { bad, good };
  }

  async fetchOrigBinary(page: Page, type: string, url: string, ts: string) {
    const frame = page.frames()[1];
    if (!frame) {
      logger.warn("Replay frame missing", { url }, "replay");
      return;
    }

    const replayUrl = REPLAY_PREFIX + `${ts}mp_/urn:${type}:${url}`;

    const binaryString = await frame.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
      });
      if (response.status !== 200) {
        return "";
      }
      const blob = await response.blob();
      const result = new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsBinaryString(blob);
      });
      return result;
    }, replayUrl);

    return Buffer.from(binaryString as string, "binary");
  }

  async fetchOrigText(page: Page, type: string, url: string, ts: string) {
    const frame = page.frames()[1];
    if (!frame) {
      logger.warn("Replay frame missing", { url }, "replay");
      return;
    }

    const replayUrl = REPLAY_PREFIX + `${ts}mp_/urn:${type}:${url}`;

    const text = await frame.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
      });
      if (response.status !== 200) {
        return "";
      }
      return await response.text();
    }, replayUrl);

    return text;
  }

  async teardownPage(opts: WorkerOpts) {
    const { page } = opts;
    await this.processPageInfo(page);
    await super.teardownPage(opts);
  }

  async processPageInfo(page: Page, state?: PageState) {
    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      if (!pageInfo.urls[pageInfo.url]) {
        logger.warn(
          "Replay resource: missing top-level page",
          { url: pageInfo.url },
          "replay",
        );
      }

      if (state) {
        const { comparison } = pageInfo;

        // add comparison to page state
        (state as ComparisonPageState).comparison = comparison;
      }

      const writer = new WARCResourceWriter({
        url: pageInfo.url,
        directory: this.archivesDir,
        warcPrefix: this.warcPrefix,
        date: new Date(),
        warcName: "info.warc.gz",
      });
      await writer.writeBufferToWARC(
        new TextEncoder().encode(JSON.stringify(pageInfo, null, 2)),
        "pageinfo",
        "application/json",
      );
      this.pageInfos.delete(page);
    }
  }

  protected pageEntryForRedis(
    entry: Record<string, string | number | boolean | object>,
    state: PageState,
  ) {
    entry.comparison = (state as ComparisonPageState).comparison;
    return entry;
  }

  createRecorder(): Recorder | null {
    return null;
  }
}

class WACZLoader {
  url: string;
  zipreader: ZipRangeReader;

  constructor(url: string) {
    this.url = url;
    this.zipreader = null;
  }

  async init() {
    if (!this.url.startsWith("http://") && !this.url.startsWith("https://")) {
      const blob = await openAsBlob(this.url);
      this.url = URL.createObjectURL(blob);
    }

    const loader = await createLoader({ url: this.url });

    this.zipreader = new ZipRangeReader(loader);
  }

  async loadFile(fileInZip: string) {
    const { reader } = await this.zipreader.loadFile(fileInZip);

    if (!reader) {
      return null;
    }

    if (!reader.iterLines) {
      return new AsyncIterReader(reader);
    }

    return reader;
  }
}
