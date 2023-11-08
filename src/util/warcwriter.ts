import fs from "fs";
import { Writable } from "stream";
import path from "path";

import { CDXIndexer } from "warcio";
import { WARCSerializer } from "warcio/node";
import { logger, errJSON } from "./logger.js";
import type { IndexerOffsetLength, WARCRecord } from "warcio";

// =================================================================
export class WARCWriter implements IndexerOffsetLength {
  archivesDir: string;
  tempCdxDir: string;
  filename: string;
  gzip: boolean;
  logDetails: Record<string, string>;

  offset = 0;
  recordLength = 0;

  indexer?: CDXIndexer;

  fh?: Writable | null;
  cdxFH?: Writable | null;

  constructor({
    archivesDir,
    tempCdxDir,
    filename,
    gzip,
    logDetails,
  }: {
    archivesDir: string;
    tempCdxDir: string;
    filename: string;
    gzip: boolean;
    logDetails: Record<string, string>;
  }) {
    this.archivesDir = archivesDir;
    this.tempCdxDir = tempCdxDir;
    this.filename = filename;
    this.gzip = gzip;
    this.logDetails = logDetails;

    this.offset = 0;
    this.recordLength = 0;

    if (this.tempCdxDir) {
      this.indexer = new CDXIndexer({ format: "cdxj" });
    }
  }

  async initFH() {
    if (!this.fh) {
      this.fh = fs.createWriteStream(
        path.join(this.archivesDir, this.filename),
      );
    }
    if (!this.cdxFH && this.tempCdxDir) {
      this.cdxFH = fs.createWriteStream(
        path.join(this.tempCdxDir, this.filename + ".cdx"),
      );
    }
  }

  async writeRecordPair(
    responseRecord: WARCRecord,
    requestRecord: WARCRecord,
    responseSerializer: WARCSerializer | undefined = undefined,
  ) {
    const opts = { gzip: this.gzip };

    if (!responseSerializer) {
      responseSerializer = new WARCSerializer(responseRecord, opts);
    }

    await this.initFH();

    this.recordLength = await this._writeRecord(
      responseRecord,
      responseSerializer,
    );

    this._writeCDX(responseRecord);

    const requestSerializer = new WARCSerializer(requestRecord, opts);
    this.recordLength = await this._writeRecord(
      requestRecord,
      requestSerializer,
    );

    this._writeCDX(requestRecord);
  }

  async _writeRecord(record: WARCRecord, serializer: WARCSerializer) {
    let total = 0;
    const url = record.warcTargetURI;

    if (!this.fh) {
      throw new Error("writer not initialized");
    }

    for await (const chunk of serializer) {
      total += chunk.length;
      try {
        this.fh.write(chunk);
      } catch (e) {
        logger.error(
          "Error writing to WARC, corruption possible",
          { ...errJSON(e), url, ...this.logDetails },
          "writer",
        );
      }
    }

    return total;
  }

  _writeCDX(record: WARCRecord | null) {
    if (this.indexer) {
      const cdx = this.indexer.indexRecord(record, this, this.filename);

      if (this.indexer && this.cdxFH && cdx) {
        this.indexer.write(cdx, this.cdxFH as NodeJS.WriteStream);
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
export function streamFinish(fh: Writable) {
  const p = new Promise<void>((resolve) => {
    fh.once("finish", () => resolve());
  });
  fh.end();
  return p;
}
