import fs from "fs";
import path from "path";
import * as warcio from "warcio";

export class WARCResourceWriter {
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  url: string;
  directory: string;
  warcName: string;
  date: Date;

  constructor({
    url,
    directory,
    date,
    warcPrefix,
    warcName,
  }: {
    url: string;
    directory: string;
    date: Date;
    warcPrefix: string;
    warcName: string;
  }) {
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, warcPrefix + warcName);
    this.date = date ? date : new Date();
  }

  async writeBufferToWARC(
    contents: Uint8Array,
    resourceType: string,
    contentType: string,
  ) {
    const warcRecord = await WARCResourceWriter.createResourceRecord(
      contents,
      resourceType,
      contentType,
      this.url,
      this.date,
    );
    const warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {
      gzip: true,
    });
    fs.appendFileSync(this.warcName, warcRecordBuffer);
  }

  static async createResourceRecord(
    buffer: Uint8Array,
    resourceType: string,
    contentType: string,
    url: string,
    date: Date,
  ) {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = { "Content-Type": contentType };
    async function* content() {
      yield buffer;
    }
    const resourceUrl = `urn:${resourceType}:${url}`;

    return warcio.WARCRecord.create(
      {
        url: resourceUrl,
        date: date.toISOString(),
        type: warcRecordType,
        warcVersion,
        warcHeaders,
      },
      content(),
    );
  }
}
