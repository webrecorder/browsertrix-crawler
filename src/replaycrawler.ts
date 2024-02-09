import { Page, Protocol } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { logger } from "./util/logger.js";
import { WorkerOpts } from "./util/worker.js";
import { PageInfoRecord, Recorder } from "./util/recorder.js";

// @ts-expect-error wabac.js
import { ZipRangeReader } from "@webrecorder/wabac/src/wacz/ziprangereader.js";
// @ts-expect-error wabac.js
import { createLoader } from "@webrecorder/wabac/src/blockloaders.js";
import { AsyncIterReader } from "warcio";
import { WARCResourceWriter } from "./util/warcresourcewriter.js";
import { parseArgs } from "./util/argParser.js";

//import { openAsBlob } from "node:fs";

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
};

// ============================================================================
export class ReplayCrawler extends Crawler {
  replayServer: ReplayServer;
  replaySource: string;

  pageInfos: Map<Page, PageInfoRecord>;

  reloadTimeouts: WeakMap<Page, NodeJS.Timeout>;

  constructor() {
    super();
    this.recording = false;
    if (!this.params.replaySource) {
      throw new Error("Missing replay source");
    }
    this.replaySource = this.params.replaySource;
    this.replayServer = new ReplayServer(this.replaySource);

    this.pageInfos = new Map<Page, PageInfoRecord>();

    // skip text from first two frames, as they are RWP boilerplate
    this.skipTextDocs = 2;

    this.params.scopedSeeds = [];

    this.reloadTimeouts = new WeakMap<Page, NodeJS.Timeout>();
  }

  protected parseArgs() {
    return parseArgs(process.argv, true);
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

    await this.loadPages(this.replaySource);
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

    const pagesReader = await loader.loadFile("pages/pages.jsonl");

    if (pagesReader) {
      for await (const buff of pagesReader.iterLines()) {
        await this.addPage(buff);
        if (this.limitHit) {
          break;
        }
      }
    }

    const extraPagesReader = await loader.loadFile("pages/extraPages.jsonl");

    if (extraPagesReader) {
      for await (const buff of extraPagesReader.iterLines()) {
        await this.addPage(buff);
        if (this.limitHit) {
          break;
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

    await this.queueUrl(0, url, 1, 0, {}, ts);
  }

  handleRequestWillBeSent(
    params: Protocol.Network.RequestWillBeSentEvent,
    page: Page,
  ) {
    // only handling redirect here, committing last response in redirect chain
    const { redirectResponse } = params;
    if (redirectResponse) {
      const { url, status } = redirectResponse;
      this.addPageResource(url, status, page);
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

    this.addPageResource(url, status, page);
  }

  addPageResource(url: string, status: number, page: Page) {
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

    const date = ts ? new Date(ts) : undefined;

    const timestamp = date
      ? date.toISOString().slice(0, 19).replace(/[T:-]/g, "")
      : "";

    logger.info("Loading Replay", { url, timestamp }, "replay");

    const pageInfo = { pageid, urls: {}, url, ts: date };
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
