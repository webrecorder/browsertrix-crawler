import { Frame, Page, Protocol } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { ScopedSeed } from "./util/seeds.js";
import { logger } from "./util/logger.js";
import { WorkerOpts } from "./util/worker.js";
import { PageInfoRecord, Recorder } from "./util/recorder.js";

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
};

type PageInfoWithUrl = PageInfoRecord & {
  url: string;
  timestamp: string;
};

export class ReplayCrawler extends Crawler {
  replayServer: ReplayServer;
  replaySource: string;

  pagesLoaded = false;

  pageInfos: Map<Page, PageInfoWithUrl>;

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
  }

  async setupPage(opts: WorkerOpts) {
    await super.setupPage(opts);
    const { page, cdp } = opts;

    if (!this.replaySource) {
      throw new Error("Missing replay source");
    }

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

    if (!this.pagesLoaded) {
      await this.loadPageList(frame);
      this.pagesLoaded = true;
    }

    await cdp.send("Network.enable");

    cdp.on("Network.responseReceived", async (params) =>
      this.handlePageResponse(params, page),
    );
  }

  async loadPageList(frame: Frame) {
    let res;

    while (true) {
      res = await frame.evaluate(async () => {
        const res = await fetch(
          "http://localhost:9990/replay/w/api/c/replay?all=1",
        );
        const json = res.json();
        return json;
      });

      if (res.error) {
        console.log("ERR SLEEPING");
        await sleep(5);
      } else {
        break;
      }
    }

    const scopedSeeds = [];

    for (const page of res.pages) {
      const { url, ts } = page;
      scopedSeeds.push(
        new ScopedSeed({ url, scopeType: "page", depth: 1, include: [] }),
      );

      if (
        !(await this.queueUrl(scopedSeeds.length - 1, page.url, 0, 0, {}, ts))
      ) {
        if (this.limitHit) {
          break;
        }
      }
    }

    let textIndex: string;

    while (true) {
      textIndex = await frame.evaluate(async () => {
        const res = await fetch(
          "http://localhost:9990/replay/w/api/c/replay/textIndex",
        );
        const text = res.text();
        return text;
      });

      if (res.error) {
        await sleep(5);
      } else {
        break;
      }
    }

    for (const page of textIndex.split("\n")) {
      let pageData: ReplayPage;

      try {
        pageData = JSON.parse(page);
      } catch (e) {
        continue;
      }

      const { url, ts } = pageData;
      if (!url) {
        continue;
      }

      scopedSeeds.push(
        new ScopedSeed({ url, scopeType: "page", depth: 1, include: [] }),
      );

      if (!(await this.queueUrl(scopedSeeds.length - 1, url, 0, 0, {}, ts))) {
        if (this.limitHit) {
          break;
        }
      }
    }

    this.params.scopedSeeds = scopedSeeds;

    // await loadReplayPage(page, pages[0].url, pages[0].ts);
  }

  async handlePageResponse(
    params: Protocol.Network.ResponseReceivedEvent,
    page: Page,
  ) {
    const { response } = params;
    const { url, status } = response;
    if (!url || !url.startsWith("http://localhost:9990/replay/w/replay/")) {
      return;
    }

    const inx = url.indexOf("_/");
    if (inx <= 0) {
      return;
    }

    let replayUrl = url.slice(inx + 2);

    //const pageUrl = this.pagesToUrl.get(page);
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

    this.processPageInfo(page);
  }

  async teardownPage(opts: WorkerOpts) {
    const { page } = opts;
    this.processPageInfo(page);
    await super.teardownPage(opts);
  }

  processPageInfo(page: Page) {
    const pageInfo = this.pageInfos.get(page);
    if (pageInfo) {
      console.log(pageInfo);
      this.pageInfos.delete(page);
    }
  }

  createRecorder(): Recorder | null {
    return null;
  }
}
