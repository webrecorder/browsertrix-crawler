import fs from "fs";
import path from "path";
import * as warcio from "warcio";
import sharp from "sharp";

import { logger, errJSON } from "./logger.js";

// ============================================================================

export const screenshotTypes = {
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


export class Screenshots {
  browser: any;
  page: any;
  url: string;
  directory: string;
  warcName: string;
  date: Date;

  constructor({browser, page, url, date, directory}) {
    this.browser = browser;
    this.page = page;
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, "screenshots.warc.gz");
    this.date = date ? date : new Date();
  }

  async take(screenshotType="view") {
    try {
      if (screenshotType !== "fullPage") {
        await this.browser.setViewport(this.page, {width: 1920, height: 1080});
      }
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      await this.writeBufferToWARC(screenshotBuffer, screenshotType, options.type);
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
      await this.writeBufferToWARC(thumbnailBuffer, screenshotType, options.type);
      logger.info(`Screenshot (type: thumbnail) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      logger.error("Taking screenshot failed", {"page": this.url, type: screenshotType, ...errJSON(e)}, "screenshots");
    }
  }

  async writeBufferToWARC(screenshotBuffer, screenshotType, imageType) {
    const warcRecord = await this.wrap(screenshotBuffer, screenshotType, imageType);
    const warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
    fs.appendFileSync(this.warcName, warcRecordBuffer);
  }

  async wrap(buffer, screenshotType="screenshot", imageType="png") {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = {"Content-Type": `image/${imageType}`};
    async function* content() {
      yield buffer;
    }
    let screenshotUrl = `urn:${screenshotType}:` + this.url;
    return warcio.WARCRecord.create({
      url: screenshotUrl,
      date: this.date.toISOString(),
      type: warcRecordType,
      warcVersion,
      warcHeaders}, content());
  }
}
