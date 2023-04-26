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
    for (const {orig, dest} of this.originOverride) {
      const logDetails = {page: page.url(), orig, dest};

      logger.debug(`Adding override ${orig} => ${dest}`);

      page.on("request", async (request) => {
        try {
          const url = request.url();
          if (!url.startsWith(orig)) {
            request.continue({}, -1);
          }

          const newUrl = dest + url.slice(orig.length);
          const resp = await fetch(newUrl, {headers: request.headers()});

          const body = Buffer.from(await resp.arrayBuffer());
          const headers = Object.fromEntries(resp.headers);
          const status = resp.status;

          logger.debug("Origin overridden", {orig: url, dest: newUrl, status, body: body.length}, "originoverride");

          request.respond({body, headers, status}, -1);

        } catch (e) {
          logger.warn("Error overriding origin", {...errJSON(e), ...logDetails}, "originoverride");
        }
      });
    }
  }
}
