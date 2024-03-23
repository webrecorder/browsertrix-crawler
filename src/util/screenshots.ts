import sharp from "sharp";

import { logger, formatErr } from "./logger.js";
import { Browser } from "./browser.js";
import { Page } from "puppeteer-core";
import { PageState } from "./state.js";
import { WARCWriter } from "./warcwriter.js";

// ============================================================================

type ScreenShotDesc = {
  type: "png" | "jpeg";
  omitBackground: boolean;
  fullPage: boolean;
  encoding: "binary";
};

type ScreeshotType = "view" | "thumbnail" | "fullPage";

export const screenshotTypes: Record<string, ScreenShotDesc> = {
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
  writer: WARCWriter;
};

export class Screenshots {
  browser: Browser;
  page: Page;
  url: string;
  writer: WARCWriter;

  constructor({ browser, page, writer, url }: ScreenshotOpts) {
    this.browser = browser;
    this.page = page;
    this.url = url;
    this.writer = writer;
  }

  async take(
    screenshotType: ScreeshotType = "view",
    state: PageState | null = null,
  ) {
    try {
      if (screenshotType !== "fullPage") {
        await this.browser.setViewport(this.page, {
          width: 1920,
          height: 1080,
        });
      }
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      if (state && screenshotType === "view") {
        state.screenshotView = screenshotBuffer;
      }
      await this.writer.writeNewResourceRecord({
        buffer: screenshotBuffer,
        resourceType: screenshotType,
        contentType: "image/" + options.type,
        url: this.url,
      });
      logger.info(
        `Screenshot (type: ${screenshotType}) for ${this.url} written to ${this.writer.filename}`,
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
      await this.writer.writeNewResourceRecord({
        buffer: thumbnailBuffer,
        resourceType: screenshotType,
        contentType: "image/" + options.type,
        url: this.url,
      });
      logger.info(
        `Screenshot (type: thumbnail) for ${this.url} written to ${this.writer.filename}`,
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
