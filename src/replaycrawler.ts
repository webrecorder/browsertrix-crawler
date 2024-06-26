import { Page, Protocol } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { logger, formatErr } from "./util/logger.js";
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
import { parseArgs } from "./util/argParser.js";

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

import levenshtein from "js-levenshtein";
import { MAX_URL_LENGTH } from "./util/reqresp.js";
import { openAsBlob } from "fs";
import { WARCWriter } from "./util/warcwriter.js";
import { parseRx } from "./util/seeds.js";

// RWP Replay Prefix
const REPLAY_PREFIX = "http://localhost:9990/replay/w/replay/";

// RWP Source Url
const REPLAY_SOURCE = "http://localhost:9990/replay/?source=";

// When iterating over page.frames(), the first two frames are for the top-level page
// and RWP embed, the actual content starts with frame index 2
const SKIP_FRAMES = 2;

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
  mime?: string;
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
// Crawler designed to run over replay of existing WACZ files to generate comparison
// data (eg. for QA)
export class ReplayCrawler extends Crawler {
  replayServer: ReplayServer;
  qaSource: string;

  pageInfos: Map<Page, ReplayPageInfoRecord>;
  infoWriter: WARCWriter | null;

  reloadTimeouts: WeakMap<Page, NodeJS.Timeout>;

  includeRx: RegExp[];
  excludeRx: RegExp[];

  // for qaDebugImageDiff incremental file output
  counter: number = 0;

  constructor() {
    super();
    this.recording = false;
    if (!this.params.qaSource) {
      throw new Error("Missing QA source");
    }
    this.qaSource = this.params.qaSource;
    this.replayServer = new ReplayServer(this.qaSource);

    logger.info(
      "Replay Crawl with Source",
      { source: this.qaSource },
      "general",
    );

    this.pageInfos = new Map<Page, ReplayPageInfoRecord>();

    // skip text from first two frames, as they are RWP boilerplate
    this.skipTextDocs = SKIP_FRAMES;

    this.params.scopedSeeds = [];

    this.params.screenshot = ["view"];
    this.params.text = ["to-warc"];

    this.params.serviceWorker = "enabled";

    this.reloadTimeouts = new WeakMap<Page, NodeJS.Timeout>();

    this.infoWriter = null;

    this.includeRx = parseRx(this.params.include);
    this.excludeRx = parseRx(this.params.include);
  }

  async bootstrap(): Promise<void> {
    await super.bootstrap();

    this.infoWriter = this.createExtraResourceWarcWriter("info");
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

    await this.awaitRWPLoad(page);
  }

  async awaitRWPLoad(page: Page) {
    await page.goto(this.replayServer.homePage);

    // wait until content frame is available
    while (page.frames().length <= SKIP_FRAMES) {
      await sleep(5);
    }

    const frame = page.frames()[1];

    await frame.evaluate(() => {
      return navigator.serviceWorker.ready;
    });

    return page.frames()[SKIP_FRAMES];
  }

  protected async _addInitialSeeds() {
    await this.loadPages(this.qaSource);
  }

  async isInScope() {
    return true;
  }

  async loadPages(url: string) {
    let path = url;

    try {
      path = new URL(url).pathname;
    } catch (e) {
      // ignore
    }

    if (path.endsWith(".wacz")) {
      await this.loadPagesForWACZ(url);
    } else if (path.endsWith(".json")) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        const blob = await openAsBlob(url);
        url = URL.createObjectURL(blob);
      }

      const resp = await fetch(url);
      const json = await resp.json();

      // if json contains pages, just load them directly
      if (json.pages) {
        await this.loadPagesDirect(json.pages);
      } else {
        // otherwise, parse pages from WACZ files
        for (const entry of json.resources) {
          if (entry.path) {
            await this.loadPages(entry.path);
          }
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

  async _addPageIfInScope({ url, ts, id, mime }: ReplayPage, depth: number) {
    if (mime && mime !== "text/html") {
      logger.info("Skipping non-HTML page", { url, mime }, "replay");
      return;
    }

    if (this.includeRx.length) {
      let inScope = false;
      for (const s of this.includeRx) {
        if (s.test(url)) {
          inScope = true;
          break;
        }
      }
      if (!inScope) {
        logger.info("Skipping not included page", { url }, "replay");
        return;
      }
    }

    for (const s of this.excludeRx) {
      if (!s.test(url)) {
        logger.info("Skipping excluded page", { url }, "replay");
        return;
      }
    }

    await this.queueUrl(0, url, depth, 0, {}, ts, id);
  }

  async loadPagesDirect(pages: ReplayPage[]) {
    let depth = 0;
    for (const entry of pages) {
      if (!entry.url) {
        continue;
      }
      if (this.limitHit) {
        break;
      }
      await this._addPageIfInScope(entry, depth++);
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

    if (!pageData.url) {
      return;
    }

    await this._addPageIfInScope(pageData, depth);
  }

  extraChromeArgs(): string[] {
    return [...super.extraChromeArgs(), "--disable-web-security"];
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
      if (url.startsWith(REPLAY_SOURCE)) {
        const { mimeType, fromServiceWorker } = response;
        if (
          !fromServiceWorker &&
          mimeType === "application/json" &&
          page.frames().length > 1
        ) {
          const frame = page.frames()[1];
          const timeoutid = setTimeout(() => {
            logger.warn("Reloading RWP Frame, not inited", { url }, "replay");
            try {
              frame.evaluate("window.location.reload();");
            } catch (e) {
              logger.error("RWP Reload failed", e, "replay");
            }
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

    const { page, data, workerid } = opts;
    const { url, ts, pageid } = data;

    if (!ts) {
      return;
    }

    const date = new Date(ts);

    const timestamp = date.toISOString().slice(0, 19).replace(/[T:-]/g, "");

    const logDetails = { url, timestamp, id: workerid, pageid };

    logger.info("Loading Replay", logDetails, "replay");

    const pageInfo = {
      pageid,
      urls: {},
      url,
      ts: date,
      comparison: { resourceCounts: {} },
      counts: { jsErrors: 0 },
    };
    this.pageInfos.set(page, pageInfo);

    let replayFrame;

    if (page.frames().length <= SKIP_FRAMES) {
      logger.warn("RWP possibly crashed, reloading page", logDetails, "replay");
      //throw new Error("logged");
      replayFrame = await this.awaitRWPLoad(page);
    } else {
      replayFrame = page.frames()[SKIP_FRAMES];
    }

    try {
      await replayFrame.goto(
        `${REPLAY_PREFIX}${timestamp}mp_/${url}`,
        this.gotoOpts,
      );
    } catch (e) {
      logger.warn(
        "Loading replay timed out",
        { ...logDetails, ...formatErr(e) },
        "replay",
      );
    }

    // optionally reload (todo: reevaluate if this is needed)
    // await page.reload();

    await this.awaitPageLoad(replayFrame, logDetails);

    data.isHTMLPage = true;

    data.filteredFrames = page.frames().slice(SKIP_FRAMES);

    try {
      data.title = await replayFrame.title();
    } catch (e) {
      // ignore
    }

    data.favicon = await this.getFavicon(page, {});

    await this.doPostLoadActions(opts, true);

    await this.awaitPageExtraDelay(opts);

    await this.compareScreenshots(page, data, url, date, workerid);

    await this.compareText(page, data, url, date);

    await this.compareResources(page, data, url, date);

    await this.processPageInfo(page, data);
  }

  async compareScreenshots(
    page: Page,
    state: PageState,
    url: string,
    date: Date,
    workerid: number,
  ) {
    const origScreenshot = await this.fetchOrigBinary(
      page,
      "view",
      url,
      date.toISOString().replace(/[^\d]/g, ""),
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
    const diffImage = new PNG({ width, height });

    const diff = pixelmatch(
      crawl.data,
      replay.data,
      diffImage.data,
      width,
      height,
      {
        threshold: 0.1,
        alpha: 0,
      },
    );

    const total = width * height;

    const matchPercent = (total - diff) / total;

    logger.info("Screenshot Diff", { url, diff, matchPercent }, "replay");

    if (this.params.qaDebugImageDiff) {
      const dir = path.join(this.collDir, "screenshots");
      await fsp.mkdir(dir, { recursive: true });
      const counter = this.counter++;
      logger.debug(
        `Saving crawl/replay/vdiff images to ${counter}-${workerid}-${pageid}-{crawl,replay,vdiff}.png`,
        { url },
        "replay",
      );
      await fsp.writeFile(
        path.join(dir, `${counter}-${workerid}-${pageid}-crawl.png`),
        PNG.sync.write(crawl),
      );
      await fsp.writeFile(
        path.join(dir, `${counter}-${workerid}-${pageid}-replay.png`),
        PNG.sync.write(replay),
      );
      if (diff && matchPercent < 1) {
        await fsp.writeFile(
          path.join(dir, `${counter}-${workerid}-${pageid}-vdiff.png`),
          PNG.sync.write(diffImage),
        );
      }
    }

    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      pageInfo.comparison.screenshotMatch = matchPercent;
    }
  }

  async compareText(page: Page, state: PageState, url: string, date: Date) {
    const origText = await this.fetchOrigText(
      page,
      "text",
      url,
      date.toISOString().replace(/[^\d]/g, ""),
    );
    const replayText = state.text;

    if (origText === undefined || replayText === undefined) {
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

    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      pageInfo.comparison.textMatch = matchPercent;
    }
  }

  async compareResources(
    page: Page,
    state: PageState,
    url: string,
    date: Date,
  ) {
    const origResources = await this.fetchOrigText(
      page,
      "pageinfo",
      url,
      date.toISOString().replace(/[^\d]/g, ""),
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
  }

  countResources(info: PageInfoRecord) {
    let good = 0;
    let bad = 0;

    for (const [url, { status }] of Object.entries(info.urls)) {
      if (!url.startsWith("http")) {
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

    if (!binaryString) {
      logger.warn("Couldn't fetch original data", { type, url, ts }, "replay");
    }

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
        return undefined;
      }
      return await response.text();
    }, replayUrl);

    if (text === undefined) {
      logger.warn("Couldn't fetch original data", { type, url, ts }, "replay");
    }

    return text;
  }

  async teardownPage(opts: WorkerOpts) {
    const { page } = opts;
    await this.processPageInfo(page);
    await super.teardownPage(opts);
  }

  async closeFiles() {
    await super.closeFiles();

    if (this.infoWriter) {
      await this.infoWriter.flush();
    }
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

      this.infoWriter?.writeNewResourceRecord(
        {
          buffer: new TextEncoder().encode(JSON.stringify(pageInfo, null, 2)),
          resourceType: "pageinfo",
          contentType: "application/json",
          url: pageInfo.url,
        },
        { type: "pageinfo", url: pageInfo.url },
        "replay",
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
