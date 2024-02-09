import sharp from "sharp";

import { WARCResourceWriter } from "./warcresourcewriter.js";
import { logger, formatErr } from "./logger.js";
import { Browser } from "./browser.js";
import { Page } from "puppeteer-core";

// ============================================================================

type ScreenShotType = {
  type: "png" | "jpeg";
  omitBackground: boolean;
  fullPage: boolean;
  encoding: "binary";
};

export const screenshotTypes: Record<string, ScreenShotType> = {
  view: {
    type: "png",
    omitBackground: true,
    fullPage: false,
    encoding: "binary",
  },
  thumbnail: {
    type: "jpeg",
    omitBackground: true,
    fullPage: false,
    encoding: "binary",
  },
  fullPage: {
    type: "png",
    omitBackground: true,
    fullPage: true,
    encoding: "binary",
  },
};

export type ScreenshotOpts = {
  browser: Browser;
  page: Page;
  url: string;
  directory: string;
};

export class Screenshots extends WARCResourceWriter {
  browser: Browser;
  page: Page;

  constructor(opts: ScreenshotOpts) {
    super({ ...opts, warcName: "screenshots.warc.gz" });
    this.browser = opts.browser;
    this.page = opts.page;
  }

  async take(screenshotType = "view") {
    try {
      if (screenshotType !== "fullPage") {
        await this.browser.setViewport(this.page, {
          width: 1920,
          height: 1080,
        });
      }
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      await this.writeBufferToWARC(
        screenshotBuffer,
        screenshotType,
        "image/" + options.type,
      );
      logger.info(
        `Screenshot (type: ${screenshotType}) for ${this.url} written to ${this.warcName}`,
      );
    } catch (e) {
      logger.error(
        "Taking screenshot failed",
        { page: this.url, type: screenshotType, ...formatErr(e) },
        "screenshots",
      );
    }
  }

  async takeFullPage() {
    await this.take("fullPage");
  }

  async takeThumbnail() {
    const screenshotType = "thumbnail";
    try {
      await this.browser.setViewport(this.page, { width: 1920, height: 1080 });
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      const thumbnailBuffer = await sharp(screenshotBuffer)
        // 16:9 thumbnail
        .resize(640, 360)
        .toBuffer();
      await this.writeBufferToWARC(
        thumbnailBuffer,
        screenshotType,
        "image/" + options.type,
      );
      logger.info(
        `Screenshot (type: thumbnail) for ${this.url} written to ${this.warcName}`,
      );
    } catch (e) {
      logger.error(
        "Taking screenshot failed",
        { page: this.url, type: screenshotType, ...formatErr(e) },
        "screenshots",
      );
    }
  }
}
