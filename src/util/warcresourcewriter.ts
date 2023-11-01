import fs from "fs";
import path from "path";
import * as warcio from "warcio";

export class WARCResourceWriter
{
  page: any;
  url: string;
  directory: string;
  warcName: string;
  date: Date;

  constructor({url, directory, date, warcName} : {url: string, directory: string, date: Date, warcName: string}) {
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, warcName);
    this.date = date ? date : new Date();
  }

  async writeBufferToWARC(contents: Uint8Array, resourceType: string, contentType: string) {
    const warcRecord = await this.wrap(contents, resourceType, contentType);
    const warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
    fs.appendFileSync(this.warcName, warcRecordBuffer);
  }

  async wrap(buffer: Uint8Array, resourceType: string, contentType: string) {
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
