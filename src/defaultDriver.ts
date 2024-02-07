import { Crawler } from "./crawler.js";
import { WorkerOpts } from "./util/worker.js";

export default class DefaultDriver {
  async setupPage(/*opts: WorkerOpts, crawler: Crawler*/) {
    // handle any operations for when new page is created here
  }

  async crawlPage(opts: WorkerOpts, crawler: Crawler) {
    const { page, data } = opts;
    await crawler.loadPage(page, data);
  }

  async teardownPage(/*opts: WorkerOpts, crawler: Crawler*/) {
    // handle any operations for when a page is closed here
  }
}
