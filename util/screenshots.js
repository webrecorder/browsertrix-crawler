const fs = require("fs");
const path = require("path");
const warcio = require("warcio");
// ============================================================================

class Screenshots {

  constructor({page, id, url, date, directory}) {
    this.page = page;
    this.id = id;
    this.url = url;
    this.directory = directory;
    this.date = date ? date : new Date();
  }

  async take() {
    const warcName = path.join(this.directory, "screenshot-" + this.id + ".warc.gz");
    try {
      await this.page.setViewport({width: 1920, height: 1080}); // FullHD
      let screenshotBuffer = await this.page.screenshot({omitBackground: true, fullPage: false, path: "/crawls/test.png"});
      let warcRecord = await this.wrap(screenshotBuffer);
      let warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
      fs.appendFileSync(warcName, warcRecordBuffer);
      let digest = warcRecord.warcPayloadDigest;
      console.log(`Screenshot for ${this.url} written to ${warcName}`);
      // take full page screenshot
      screenshotBuffer = await this.page.screenshot({omitBackground: true, fullPage: true});
      warcRecord = await this.wrap(screenshotBuffer);
      warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
      if (digest === warcRecord.warcPayloadDigest) {
        console.log("Skipping full page screenshot (identical to simple screenshot)");
      } else {
        fs.appendFileSync(warcName, warcRecordBuffer);
        console.log(`Full page screenshot for ${this.url} written to ${warcName}`);
      }
    } catch (e) {
      console.log(`Taking screenshots failed for ${this.url}`, e);
    }
  }

  async wrap(buffer) {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = {"Content-Type": "image/png"};
    async function* content() {
      yield buffer;
    }
    let screenshotUrl = "urn:screenshot:" + this.url;
    return warcio.WARCRecord.create({
      url: screenshotUrl,
      date: this.date.toISOString(),
      type: warcRecordType,
      warcVersion,
      warcHeaders}, content());
  }
}

module.exports = Screenshots;
