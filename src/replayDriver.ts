import { Frame, Page } from "puppeteer-core";
import { Crawler } from "./crawler.js";
import { ReplayServer } from "./util/replayserver.js";
import { sleep } from "./util/timing.js";
import { ScopedSeed } from "./util/seeds.js";
import { logger } from "./util/logger.js";
import { WorkerOpts } from "./util/worker.js";

type ReplayPage = {
  url: string;
  ts: number;
  id: string;
};

export default class ReplayDriver {
  replayServer: ReplayServer;
  pagesLoaded = false;
  lastPage: Page | null = null;

  constructor(crawler: Crawler) {
    if (!crawler.replaySource) {
      throw new Error("Missing replay source");
    }
    this.replayServer = new ReplayServer(crawler.replaySource);
  }

  async setupPage(opts: WorkerOpts, crawler: Crawler) {
    const { page } = opts;

    console.log("SETUP PAGE");

    await this.initReplayPage(crawler, page);
  }

  async initReplayPage(crawler: Crawler, page: Page) {
    if (!crawler.replaySource) {
      throw new Error("Missing replay source");
    }

    await page.goto(this.replayServer.homePage);

    while (page.frames().length < 2) {
      console.log("Frames: " + page.frames().length);
      await sleep(5);
    }

    const frame = page.frames()[1];
    //console.log(frame.url());

    await frame.evaluate(() => {
      return navigator.serviceWorker.ready;
    });

    if (!this.pagesLoaded) {
      await this.loadPageList(crawler, page, frame);
      this.pagesLoaded = true;
    }
  }

  async loadPageList(crawler: Crawler, page: Page, frame: Frame) {
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
        !(await crawler.queueUrl(
          scopedSeeds.length - 1,
          page.url,
          0,
          0,
          {},
          ts,
        ))
      ) {
        if (crawler.limitHit) {
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

      if (
        !(await crawler.queueUrl(scopedSeeds.length - 1, url, 0, 0, {}, ts))
      ) {
        if (crawler.limitHit) {
          break;
        }
      }
    }

    crawler.params.scopedSeeds = scopedSeeds;

    // await loadReplayPage(page, pages[0].url, pages[0].ts);
  }

  async crawlPage(opts: WorkerOpts /*, crawler: Crawler*/) {
    const { page, data } = opts;
    await this.loadReplayPage(page, data.url, data.ts);
  }

  async loadReplayPage(page: Page, url: string, ts: number) {
    if (!ts) {
      return;
    }

    const timestamp = ts
      ? new Date(ts).toISOString().slice(0, 19).replace(/[T:-]/g, "")
      : "";

    logger.info("Loading Replay", { url, timestamp }, "replay");

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
  }

  async teardownPage(/*opts: WorkerOpts, crawler: Crawler*/) {
    // handle any operations for when a page is closed here
    console.log("TEARDOWN PAGE");
  }
}