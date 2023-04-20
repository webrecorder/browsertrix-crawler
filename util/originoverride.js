import { errJSON, logger } from "./logger.js";

export class OriginOverride
{
  constructor(originOverride) {
    this.originOverride = originOverride.map((override) => {
      let [orig, dest] = override.split("=");
      orig = new URL(orig).origin;
      dest = new URL(dest).origin;

      return {orig, dest};
    });
  }

  initPage(page) {
    for (const {orig, dest} of this.originOverride) {
      const logDetails = {page: page.url(), orig, dest};

      logger.debug(`Adding override ${orig} => ${dest}`);

      page.route(orig + "/**", async (route) => {
        try {
          const request = route.request();
          const url = request.url();

          const newUrl = dest + url.slice(orig.length);
          const resp = await fetch(newUrl, {headers: request.headers()});

          const body = Buffer.from(await resp.arrayBuffer());
          const headers = Object.fromEntries(resp.headers);
          const status = resp.status;

          logger.debug("Origin overridden", {orig: url, dest: newUrl, status, body: body.length}, "originoverride");

          route.fulfill({body, headers, status});

        } catch (e) {
          logger.warn("Error overriding origin", {...errJSON(e), ...logDetails}, "originoverride");
        }
      });
    }
  }
}
