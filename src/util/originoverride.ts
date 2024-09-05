import { HTTPRequest, Page } from "puppeteer-core";
import { formatErr, logger } from "./logger.js";
import { Browser } from "./browser.js";

import { fetch } from "undici";

export class OriginOverride {
  originOverride: { origUrl: URL; destUrl: URL }[];

  constructor(originOverride: string[]) {
    this.originOverride = originOverride.map((override) => {
      const [orig, dest] = override.split("=");
      const origUrl = new URL(orig);
      const destUrl = new URL(dest);

      return { origUrl, destUrl };
    });
  }

  async initPage(browser: Browser, page: Page) {
    const onRequest = async (request: HTTPRequest) => {
      try {
        const url = request.url();

        let newUrl = null;
        let orig = null;

        for (const { origUrl, destUrl } of this.originOverride) {
          if (url.startsWith(origUrl.origin)) {
            newUrl = destUrl.origin + url.slice(origUrl.origin.length);
            orig = origUrl;
            break;
          }
        }

        if (!newUrl || !orig) {
          request.continue({}, -1);
          return;
        }

        const headers = new Headers(request.headers());

        headers.set("host", orig.host);
        if (headers.get("origin")) {
          headers.set("origin", orig.origin);
        }

        const resp = await fetch(newUrl, { headers });

        const body = Buffer.from(await resp.arrayBuffer());
        const respHeaders = Object.fromEntries(resp.headers);
        const status = resp.status;

        logger.debug(
          "Origin overridden",
          { orig: url, dest: newUrl, status, body: body.length },
          "originOverride",
        );

        request.respond({ body, headers: respHeaders, status }, -1);
      } catch (e) {
        logger.warn(
          "Error overriding origin",
          { ...formatErr(e), url: page.url() },
          "originOverride",
        );
        request.continue({}, -1);
      }
    };
    await browser.interceptRequest(page, onRequest);
  }
}
