import fs from "fs";
import path from "path";
import * as warcio from "warcio";

export class WARCResourceWriter
{
  constructor({url, directory, date, warcName}) {
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, warcName);
    this.date = date ? date : new Date();
  }

  async writeBufferToWARC(contents, resourceType, contentType) {
    const warcRecord = await this.wrap(contents, resourceType, contentType);
    const warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
    fs.appendFileSync(this.warcName, warcRecordBuffer);
  }

  async wrap(buffer, resourceType, contentType) {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = {"Content-Type": contentType};
    async function* content() {
      yield buffer;
    }
    let resourceUrl = `urn:${resourceType}:${this.url}`;

    return warcio.WARCRecord.create({
      url: resourceUrl,
      date: this.date.toISOString(),
      type: warcRecordType,
      warcVersion,
      warcHeaders
    }, content());
  }
}
