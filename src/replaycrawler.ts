import { Page, Protocol } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { ScopedSeed } from "./util/seeds.js";
import { logger } from "./util/logger.js";
import { WorkerOpts } from "./util/worker.js";
import { PageInfoRecord, Recorder } from "./util/recorder.js";

// @ts-expect-error wabac.js
import { ZipRangeReader } from "@webrecorder/wabac/src/wacz/ziprangereader.js";
// @ts-expect-error wabac.js
import { createLoader } from "@webrecorder/wabac/src/blockloaders.js";
import { AsyncIterReader } from "warcio";
import { WARCResourceWriter } from "./util/warcresourcewriter.js";

//import { openAsBlob } from "node:fs";

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
};

type PageInfoWithUrl = PageInfoRecord & {
  url: string;
  timestamp: string;
};

// ============================================================================
export class ReplayCrawler extends Crawler {
  replayServer: ReplayServer;
  replaySource: string;

  pageInfos: Map<Page, PageInfoWithUrl>;

  timeoutId?: NodeJS.Timeout;

  maxPages: number = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(args: Record<string, any>) {
    super(args);
    this.recording = false;
    if (!this.params.replaySource) {
      throw new Error("Missing replay source");
    }
    this.replaySource = this.params.replaySource;
    this.replayServer = new ReplayServer(this.replaySource);

    this.pageInfos = new Map<Page, PageInfoWithUrl>();

    this.maxPages = this.params.limit;

    // skip text from first two frames, as they are RWP boilerplate
    this.skipTextDocs = 2;
  }

  async setupPage(opts: WorkerOpts) {
    await super.setupPage(opts);
    const { page, cdp } = opts;

    if (!this.replaySource) {
      throw new Error("Missing replay source");
    }

    await cdp.send("Network.enable");

    cdp.on("Network.responseReceived", async (params) =>
      this.handlePageResourceResponse(params, page),
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
    this.params.scopedSeeds = [];

    await this.loadPages(this.replaySource);
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

    const pagesReader = await loader.loadFile("pages/pages.jsonl");

    if (pagesReader) {
      for await (const buff of pagesReader.iterLines()) {
        await this.addPage(buff);
        if (this.maxPages && this.params.scopedSeeds.length >= this.maxPages) {
          return;
        }
      }
    }

    const extraPagesReader = await loader.loadFile("pages/extraPages.jsonl");

    if (extraPagesReader) {
      for await (const buff of extraPagesReader.iterLines()) {
        await this.addPage(buff);
        if (this.maxPages && this.params.scopedSeeds.length >= this.maxPages) {
          return;
        }
      }
    }
  }

  async addPage(page: string) {
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

    const { url, ts } = pageData;
    if (!url) {
      return;
    }

    const scopedSeeds = this.params.scopedSeeds;

    scopedSeeds.push(
      new ScopedSeed({ url, scopeType: "page", depth: 1, include: [] }),
    );

    if (!(await this.queueUrl(scopedSeeds.length - 1, url, 0, 0, {}, ts))) {
      if (this.limitHit) {
        return;
      }
    }
  }

  async handlePageResourceResponse(
    params: Protocol.Network.ResponseReceivedEvent,
    page: Page,
  ) {
    const { response } = params;
    const { url, status } = response;
    if (!url.startsWith("http://localhost:9990/replay/w/replay/")) {
      if (url.startsWith("http://localhost:9990/replay/?source=")) {
        const { mimeType, fromServiceWorker } = response;
        if (
          !fromServiceWorker &&
          mimeType === "application/json" &&
          page.frames().length > 1
        ) {
          const frame = page.frames()[1];
          this.timeoutId = setTimeout(() => {
            logger.warn("Reloading RWP Frame, not inited", { url }, "replay");
            frame.evaluate("window.location.reload();");
          }, 10000);
        } else if (fromServiceWorker && mimeType !== "application/json") {
          if (this.timeoutId) {
            clearTimeout(this.timeoutId);
          }
        }
      }
      return;
    }

    const inx = url.indexOf("_/");
    if (inx <= 0) {
      return;
    }

    let replayUrl = url.slice(inx + 2);

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

    if (replayUrl.startsWith("http")) {
      pageInfo.urls[replayUrl] = status;
    }
  }

  async crawlPage(opts: WorkerOpts): Promise<void> {
    const { page, data } = opts;
    const { url, ts, pageid } = data;

    if (!ts) {
      return;
    }

    const timestamp = ts
      ? new Date(ts).toISOString().slice(0, 19).replace(/[T:-]/g, "")
      : "";

    logger.info("Loading Replay", { url, timestamp }, "replay");

    const pageInfo = { pageid, urls: {}, url, timestamp };
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

    await sleep(10);

    // console.log("Frames");
    // for (const frame of page.frames()) {
    //   console.log(`${frame.name()} - ${frame.url()}`);
    // }

    data.isHTMLPage = true;

    await this.doPostLoadActions(opts);

    await this.processPageInfo(page);
  }

  async teardownPage(opts: WorkerOpts) {
    const { page } = opts;
    await this.processPageInfo(page);
    await super.teardownPage(opts);
  }

  async processPageInfo(page: Page) {
    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      if (!pageInfo.urls[pageInfo.url]) {
        logger.warn(
          "Replay resource: missing top-level page",
          { url: pageInfo.url },
          "replay",
        );
      }
      const writer = new WARCResourceWriter({
        url: pageInfo.url,
        directory: this.archivesDir,
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
    // if (!this.url.startsWith("http://") && !this.url.startsWith("https://")) {
    //   const blob = await openAsBlob(this.url);
    //   this.url = URL.createObjectURL(blob);
    // }

    const loader = await createLoader({ url: this.url });

    this.zipreader = new ZipRangeReader(loader);
  }

  async loadFile(fileInZip: string) {
    const { reader } = await this.zipreader.loadFile(fileInZip);

    if (!reader.iterLines) {
      return new AsyncIterReader(reader);
    }

    return reader;
  }
}
