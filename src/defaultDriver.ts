import { Page } from "puppeteer-core";
import { PageState } from "./util/state.js";
import { Crawler } from "./crawler.js";
import { BrowserPage } from "./util/page.js";

export default async ({
  data,
  page,
  crawler,
  browserpage,
}: {
  data: PageState;
  page: Page;
  crawler: Crawler;
  browserpage: BrowserPage;
}) => {
  await crawler.loadPage(page, data, browserpage);
};
