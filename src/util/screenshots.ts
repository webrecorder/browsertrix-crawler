import sharp from "sharp";

import { WARCResourceWriter } from "./warcresourcewriter.js";
import { logger, errJSON } from "./logger.js";
import { Browser } from "./browser.js";


// ============================================================================

type ScreenShotType = {
  type: string;
  omitBackground: boolean;
  fullPage: boolean;
}

export const screenshotTypes : Record<string, ScreenShotType> = {
  "view": {
    type: "png",
    omitBackground: true,
    fullPage: false
  },
  "thumbnail": {
    type: "jpeg",
    omitBackground: true,
    fullPage: false
  },
  "fullPage": {
    type: "png",
    omitBackground: true,
    fullPage: true
  }
};

export class Screenshots extends WARCResourceWriter {
  browser: Browser;
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(opts: any) {
    super({...opts, warcName: "screenshots.warc.gz"});
    this.browser = opts.browser;
    this.page = opts.page;
  }

  async take(screenshotType="view") {
    try {
      if (screenshotType !== "fullPage") {
        await this.browser.setViewport(this.page, {width: 1920, height: 1080});
      }
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      await this.writeBufferToWARC(screenshotBuffer, screenshotType, "image/" + options.type);
      logger.info(`Screenshot (type: ${screenshotType}) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      logger.error("Taking screenshot failed", {"page": this.url, type: screenshotType, ...errJSON(e)}, "screenshots");
    }
  }

  async takeFullPage() {
    await this.take("fullPage");
  }

  async takeThumbnail() {
    const screenshotType = "thumbnail";
    try {
      await this.browser.setViewport(this.page, {width: 1920, height: 1080});
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      const thumbnailBuffer = await sharp(screenshotBuffer)
        // 16:9 thumbnail
        .resize(640, 360)
        .toBuffer();
      await this.writeBufferToWARC(thumbnailBuffer, screenshotType, "image/" + options.type);
      logger.info(`Screenshot (type: thumbnail) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      logger.error("Taking screenshot failed", {"page": this.url, type: screenshotType, ...errJSON(e)}, "screenshots");
    }
  }
}
