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

  async initPage(page) {
    page.on("request", async (request) => {
      try {
        const url = request.url();

        let newUrl = null;

        for (const {orig, dest} of this.originOverride) {
          if (url.startsWith(orig)) {
            newUrl = dest + url.slice(orig.length);
            break;
          }
        }

        if (!newUrl) {
          request.continue({}, -1);
          return;
        }

        const resp = await fetch(newUrl, {headers: request.headers()});

        const body = Buffer.from(await resp.arrayBuffer());
        const headers = Object.fromEntries(resp.headers);
        const status = resp.status;

        logger.debug("Origin overridden", {orig: url, dest: newUrl, status, body: body.length}, "originoverride");

        request.respond({body, headers, status}, -1);

      } catch (e) {
        logger.warn("Error overriding origin", {...errJSON(e), url: page.url()}, "originoverride");
        request.continue({}, -1);
      }
    });
  }
}
