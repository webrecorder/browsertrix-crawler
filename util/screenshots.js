import fs from "fs";
import path from "path";
import * as warcio from "warcio";


// ============================================================================

class Screenshots {

  constructor({page, url, date, directory}) {
    this.page = page;
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, "screenshots.warc.gz");
    this.date = date ? date : new Date();

    this.screenshotOptions = {
      name: "screenshot",
      options: {
        type: "png",
        omitBackground: true,
        fullPage: false
      }
    };

    this.screenshotFullPageOptions = {
      name: "screenshot-fullpage",
      options: {
        type: "png",
        omitBackground: true,
        fullPage: true
      }
    };

    this.thumbnailOptions = {
      name: "thumbnail",
      options: {
        type: "jpeg",
        omitBackground: true,
        fullPage: false,
        quality: 75
      }
    };
  }

  async take(typeOptions = this.screenshotOptions) {
    try {
      await this.page.setViewport({width: 1920, height: 1080});
      let screenshotBuffer = await this.page.screenshot(typeOptions.options);
      let warcRecord = await this.wrap(screenshotBuffer, typeOptions.name, typeOptions.options.type);
      let warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
      fs.appendFileSync(this.warcName, warcRecordBuffer);
      console.log(`Screenshot (type: ${typeOptions.name}) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      console.log(`Taking screenshot (type: ${typeOptions.name}) failed for ${this.url}`, e);
    }
  }

  async takeFullPage() {
    await this.take(this.screenshotFullPageOptions);
  }

  async takeThumbnail() {
    await this.take(this.thumbnailOptions);
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

export { Screenshots };
