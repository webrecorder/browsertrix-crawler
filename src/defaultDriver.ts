import { Page } from "puppeteer-core";
import { PageState } from "./util/state.js";
import { Crawler } from "./crawler.js";

export default async ({data, page, crawler} : {data: PageState, page: Page, crawler: Crawler}) => {
  await crawler.loadPage(page, data);
};
