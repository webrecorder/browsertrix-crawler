import fs from "fs";
import path from "path";

import { CDXIndexer } from "warcio";
import { WARCSerializer } from "warcio/node";
import { logger, errJSON } from "./logger.js";


// =================================================================
export class WARCWriter
{
  constructor({archivesDir, tempCdxDir, filename, gzip, logDetails}) {
    this.archivesDir = archivesDir;
    this.tempCdxDir = tempCdxDir;
    this.filename = filename;
    this.gzip = gzip;
    this.logDetails = logDetails;

    this.offset = 0;
    this.recordLength = 0;

    if (this.tempCdxDir) {
      this.indexer = new CDXIndexer({format: "cdxj"});
    } else {
      this.indexer = null;
    }

    this.fh = null;
    this.cdxFH = null;
  }

  async initFH() {
    if (!this.fh) {
      this.fh = fs.createWriteStream(path.join(this.archivesDir, this.filename));
    }
    if (!this.cdxFH && this.tempCdxDir) {
      this.cdxFH = fs.createWriteStream(path.join(this.tempCdxDir, this.filename + ".cdx"));
    }
  }

  async writeRecordPair(responseRecord, requestRecord, responseSerializer = null) {
    const opts = {gzip: this.gzip};

    if (!responseSerializer) {
      responseSerializer = new WARCSerializer(responseRecord, opts);
    }

    await this.initFH();

    this.recordLength = await this._writeRecord(responseRecord, responseSerializer);

    this._writeCDX(responseRecord);

    const requestSerializer = new WARCSerializer(requestRecord, opts);
    this.recordLength = await this._writeRecord(requestRecord, requestSerializer);

    this._writeCDX(requestRecord);

  }

  async _writeRecord(record, serializer) {
    let total = 0;
    let count = 0;
    const url = record.warcTargetURI;

    for await (const chunk of serializer) {
      total += chunk.length;
      count++;
      try {
        this.fh.write(chunk);
      } catch (e) {
        logger.error("Error writing to WARC, corruption possible", {...errJSON(e), url, ...this.logDetails}, "writer");
      }
      if (!(count % 10)) {
        //logNetwork("Writing WARC Chunk", {total, count, url, logDetails});
      }
    }

    return total;
  }

  _writeCDX(record) {
    if (this.indexer) {
      const cdx = this.indexer.indexRecord(record, this, this.filename);

      if (this.indexer && this.cdxFH && cdx) {
        this.indexer.write(cdx, this.cdxFH);
      }
    }

    this.offset += this.recordLength;
  }

  async flush() {
    if (this.fh) {
      await streamFinish(this.fh);
      this.fh = null;
    }

    if (this.cdxFH) {
      this._writeCDX(null);

      await streamFinish(this.cdxFH);
      this.cdxFH = null;
    }
  }
}

// =================================================================
export function streamFinish(fh) {
  const p = new Promise(resolve => {
    fh.once("finish", () => resolve());
  });
  fh.end();
  return p;
}