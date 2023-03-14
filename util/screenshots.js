import fs from "fs";
import path from "path";
import * as warcio from "warcio";

import { Logger } from "./logger.js";

const logger = new Logger();

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
    fullPage: false,
    quality: 75
  },
  "fullPage": {
    type: "png",
    omitBackground: true,
    fullPage: false
  }
};


export class Screenshots {

  constructor({page, url, date, directory}) {
    this.page = page;
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, "screenshots.warc.gz");
    this.date = date ? date : new Date();
  }

  async take(screenshotType="view") {
    try {
      await this.page.setViewportSize({width: 1920, height: 1080});
      const options = screenshotTypes[screenshotType];
      const screenshotBuffer = await this.page.screenshot(options);
      const warcRecord = await this.wrap(screenshotBuffer, screenshotType, options.type);
      const warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
      fs.appendFileSync(this.warcName, warcRecordBuffer);
      logger.info(`Screenshot (type: ${screenshotType}) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      logger.error(`Taking screenshot (type: ${screenshotType}) failed for ${this.url}`, e.message);
    }
  }

  async takeFullPage() {
    await this.take("fullPage");
  }

  async takeThumbnail() {
    await this.take("thumbnail");
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
