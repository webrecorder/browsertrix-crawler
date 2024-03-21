import fs from "fs";
import { Writable } from "stream";
import path from "path";

import { CDXIndexer } from "warcio";
import { WARCSerializer } from "warcio/node";
import { logger, formatErr } from "./logger.js";
import type { IndexerOffsetLength, WARCRecord } from "warcio";
import { timestampNow } from "./timing.js";

const DEFAULT_ROLLOVER_SIZE = 1_000_000_000;

// =================================================================
export class WARCWriter implements IndexerOffsetLength {
  archivesDir: string;
  tempCdxDir?: string;
  filenameTemplate: string;
  filename?: string;
  gzip: boolean;
  logDetails: Record<string, string>;

  offset = 0;
  recordLength = 0;
  done = false;

  rolloverSize: number;

  indexer?: CDXIndexer;

  fh: Writable | null;
  cdxFH: Writable | null;

  constructor({
    archivesDir,
    tempCdxDir,
    filenameTemplate,
    rolloverSize = DEFAULT_ROLLOVER_SIZE,
    gzip,
    logDetails,
  }: {
    archivesDir: string;
    tempCdxDir?: string;
    filenameTemplate: string;
    rolloverSize?: number;
    gzip: boolean;
    logDetails: Record<string, string>;
  }) {
    this.archivesDir = archivesDir;
    this.tempCdxDir = tempCdxDir;
    this.logDetails = logDetails;
    this.gzip = gzip;
    this.rolloverSize = rolloverSize;

    this.filenameTemplate = filenameTemplate;
    this.cdxFH = null;
    this.fh = null;
  }

  _initNewFile() {
    const filename = this.filenameTemplate.replace("$ts", timestampNow());

    this.offset = 0;
    this.recordLength = 0;

    if (this.tempCdxDir) {
      this.indexer = new CDXIndexer({ format: "cdxj" });
    }

    return filename;
  }

  private async initFH() {
    if (this.offset >= this.rolloverSize) {
      logger.info(
        `Rollover size exceeded, creating new WARC`,
        {
          rolloverSize: this.rolloverSize,
          size: this.offset,
          ...this.logDetails,
        },
        "writer",
      );
      this.filename = this._initNewFile();
      this.cdxFH = null;
    } else if (!this.filename) {
      this.filename = this._initNewFile();
    }

    let fh = this.fh;

    if (!fh) {
      fh = fs.createWriteStream(path.join(this.archivesDir, this.filename));
    }
    if (!this.cdxFH && this.tempCdxDir) {
      this.cdxFH = fs.createWriteStream(
        path.join(this.tempCdxDir, this.filename + ".cdx"),
      );
    }

    return fh;
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

  async writeSingleRecord(record: WARCRecord) {
    const opts = { gzip: this.gzip };

    const requestSerializer = new WARCSerializer(record, opts);

    this.recordLength = await this._writeRecord(record, requestSerializer);

    this._writeCDX(record);
  }

  private async _writeRecord(record: WARCRecord, serializer: WARCSerializer) {
    if (this.done) {
      logger.warn(
        "Writer closed, not writing records",
        this.logDetails,
        "writer",
      );
      return 0;
    }

    let total = 0;
    const url = record.warcTargetURI;

    if (!this.fh) {
      this.fh = await this.initFH();
    }

    for await (const chunk of serializer) {
      total += chunk.length;
      try {
        this.fh.write(chunk);
      } catch (e) {
        logger.error(
          "Error writing to WARC, corruption possible",
          { ...formatErr(e), url, ...this.logDetails },
          "writer",
        );
      }
    }

    return total;
  }

  _writeCDX(record: WARCRecord | null) {
    if (this.done) {
      logger.warn("Writer closed, not writing CDX", this.logDetails, "writer");
      return;
    }

    if (this.indexer && this.filename) {
      const cdx = this.indexer.indexRecord(record, this, this.filename);

      if (this.indexer && this.cdxFH && cdx) {
        this.indexer.write(cdx, this.cdxFH as NodeJS.WriteStream);
      }
    }

    this.offset += this.recordLength;
  }

  async flush() {
    this.done = true;

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
