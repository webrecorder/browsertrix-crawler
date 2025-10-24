import path, { basename } from "node:path";
import fs, { openAsBlob } from "node:fs";
import fsp from "node:fs/promises";
import { Writable, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import child_process from "node:child_process";

import { createHash, Hash } from "node:crypto";

import { gzip } from "node:zlib";

import { ReadableStream } from "node:stream/web";

import { makeZip, InputWithoutMeta } from "client-zip";
import { logger, formatErr } from "./logger.js";
import { streamFinish } from "./warcwriter.js";
import { getDirSize } from "./storage.js";
import { request } from "undici";
import { createLoader, ZipRangeReader } from "@webrecorder/wabac";
import { AsyncIterReader } from "warcio";

const DATAPACKAGE_JSON = "datapackage.json";
const DATAPACKAGE_DIGEST_JSON = "datapackage-digest.json";

const INDEX_CDXJ = "index.cdxj";
const INDEX_IDX = "index.idx";
const INDEX_CDX_GZ = "index.cdx.gz";

const LINES_PER_BLOCK = 256;

const ZIP_CDX_MIN_SIZE = 50_000;

// ============================================================================
export type WACZInitOpts = {
  input: string[];
  output: string;
  pages: string;
  warcCdxDir: string;
  indexesDir: string;
  logDirectory: string;

  softwareString: string;

  signingUrl?: string;
  signingToken?: string;
  title?: string;
  description?: string;
  requires?: string[];
};

export type WACZResourceEntry = {
  name: string;
  path: string;
  hash: string;
  bytes: number;
};

export type WACZDataPackage = {
  resources: WACZResourceEntry[];
  created: string;
  wacz_version: string;
  software: string;
  title?: string;
  description?: string;
  relation?: { requires: string[] };
};

type WACZDigest = {
  path: string;
  hash: string;
  signedData?: string;
};

class CurrZipFileMarker extends Uint8Array {
  // empty array to mark start of WACZ file, also track metadata per-file
  filename: string;
  zipPath: string;
  size: number;
  hasher: Hash;

  constructor(filename: string, zipPath: string, size: number) {
    super();
    this.filename = filename;
    this.zipPath = zipPath;
    this.size = size;
    this.hasher = createHash("sha256");
  }
}

class EndOfZipFileMarker extends Uint8Array {
  // empty array to mark end of WACZ file
}

// ============================================================================
export class WACZ {
  collDir: string;

  warcs: string[];

  pagesDir: string;
  logsDir: string;
  warcCdxDir: string;
  indexesDir: string;

  datapackage: WACZDataPackage;

  signingUrl: string | null;
  signingToken: string | null;

  private size = 0;
  private hash: string = "";
  private localFilename = "";

  constructor(config: WACZInitOpts, collDir: string) {
    this.warcs = config.input;
    this.pagesDir = config.pages;
    this.logsDir = config.logDirectory;
    this.warcCdxDir = config.warcCdxDir;
    this.collDir = collDir;
    this.indexesDir = config.indexesDir;

    this.datapackage = {
      resources: [],
      // drop microseconds
      created: new Date().toISOString().split(".", 1)[0] + "Z",
      wacz_version: "1.1.1",
      software: config.softwareString,
    };

    if (config.title) {
      this.datapackage.title = config.title;
    }
    if (config.description) {
      this.datapackage.description = config.description;
    }

    if (config.requires && config.requires.length) {
      this.datapackage.relation = { requires: config.requires };
    }

    this.signingUrl = config.signingUrl || null;
    this.signingToken = config.signingToken || null;
  }

  generate(): Readable {
    const files = [
      ...this.warcs,
      ...addDirFiles(this.indexesDir),
      ...addDirFiles(this.pagesDir),
      ...addDirFiles(this.logsDir),
    ];

    const zip = makeZip(
      this.iterDirForZip(files),
    ) as ReadableStream<Uint8Array>;

    const hasher = createHash("sha256");
    const resources = this.datapackage.resources;

    let size = 0;

    async function* iterWACZ(wacz: WACZ): AsyncIterable<Uint8Array> {
      let currFile: CurrZipFileMarker | null = null;

      for await (const chunk of zip) {
        if (chunk instanceof CurrZipFileMarker) {
          currFile = chunk;
        } else if (chunk instanceof EndOfZipFileMarker) {
          if (currFile) {
            // Frictionless data validation requires this to be lowercase
            const name = basename(currFile.filename).toLowerCase();
            const path = currFile.zipPath;
            const bytes = currFile.size;
            const hash = "sha256:" + currFile.hasher.digest("hex");
            resources.push({ name, path, bytes, hash });
            logger.debug("Added file to WACZ", { path, bytes, hash }, "wacz");
          }
          currFile = null;
        } else {
          yield chunk;
          if (currFile) {
            currFile.hasher.update(chunk);
          }
          hasher.update(chunk);
          size += chunk.length;
        }
      }

      wacz.hash = hasher.digest("hex");
      wacz.size = size;
    }

    return Readable.from(iterWACZ(this));
  }

  getHash() {
    return this.hash;
  }

  getSize() {
    return this.size;
  }

  getLocalFilename() {
    return this.localFilename;
  }

  async generateToFile(filename: string) {
    this.localFilename = path.basename(filename);
    await pipeline(this.generate(), fs.createWriteStream(filename));
  }

  async *iterDirForZip(files: string[]): AsyncGenerator<InputWithoutMeta> {
    const encoder = new TextEncoder();
    const end = new EndOfZipFileMarker();

    async function* wrapMarkers(
      start: CurrZipFileMarker,
      iter: AsyncIterable<Uint8Array>,
    ) {
      yield start;
      yield* iter;
      yield end;
    }

    async function* getData(data: Uint8Array) {
      yield data;
    }

    for (const filename of files) {
      const input = fs.createReadStream(filename);

      const stat = await fsp.stat(filename);
      const lastModified = stat.mtime;
      const size = stat.size;

      const nameStr = filename.slice(this.collDir.length + 1);
      const name = encoder.encode(nameStr);

      const currFile = new CurrZipFileMarker(filename, nameStr, size);

      yield { input: wrapMarkers(currFile, input), lastModified, name, size };
    }

    // datapackage.json

    const datapackageData = encoder.encode(
      JSON.stringify(this.datapackage, null, 2),
    );

    yield {
      input: getData(datapackageData),
      lastModified: new Date(),
      name: DATAPACKAGE_JSON,
      size: datapackageData.length,
    };

    const hash =
      "sha256:" + createHash("sha256").update(datapackageData).digest("hex");

    // datapackage-digest.json

    const digest: WACZDigest = {
      path: DATAPACKAGE_JSON,
      hash,
    };

    // Get Signature
    if (this.signingUrl) {
      const body = JSON.stringify({
        hash,
        created: this.datapackage.created,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.signingToken) {
        headers["Authorization"] = this.signingToken;
      }

      try {
        const response = await request(this.signingUrl, {
          method: "POST",
          headers,
          body,
        });
        digest.signedData = (await response.body.json()) as string;
      } catch (e) {
        logger.warn(
          "Failed to sign WACZ, continuing w/o signature",
          { ...formatErr(e) },
          "wacz",
        );
      }
    }

    const digestData = encoder.encode(JSON.stringify(digest, null, 2));

    yield {
      input: getData(digestData),
      lastModified: new Date(),
      name: DATAPACKAGE_DIGEST_JSON,
      size: digestData.length,
    };
  }
}

// Merge CDX
export function addDirFiles(fullDir: string): string[] {
  const files = fs.readdirSync(fullDir);
  return files.map((name) => path.join(fullDir, name));
}

export async function mergeCDXJ(
  warcCdxDir: string,
  indexesDir: string,
  zipped: boolean | null = null,
) {
  async function* readLinesFrom(stdout: Readable): AsyncGenerator<string> {
    for await (const line of readline.createInterface({ input: stdout })) {
      yield line + "\n";
    }
  }

  async function* generateCompressed(
    reader: AsyncGenerator<string>,
    idxFile: Writable,
  ) {
    let offset = 0;

    const encoder = new TextEncoder();

    const filename = INDEX_CDX_GZ;

    let cdxLines: string[] = [];

    let key = "";
    let count = 0;

    idxFile.write(
      `!meta 0 ${JSON.stringify({
        format: "cdxj-gzip-1.0",
        filename: INDEX_CDX_GZ,
      })}\n`,
    );

    const finishChunk = async () => {
      const compressed = await new Promise<Uint8Array>((resolve) => {
        gzip(encoder.encode(cdxLines.join("")), (_, result) => {
          if (result) {
            resolve(result);
          }
        });
      });

      const length = compressed.length;
      const digest =
        "sha256:" + createHash("sha256").update(compressed).digest("hex");

      const idx =
        key + " " + JSON.stringify({ offset, length, digest, filename });

      idxFile.write(idx + "\n");

      offset += length;

      count = 1;
      key = "";
      cdxLines = [];

      return compressed;
    };

    for await (const cdx of reader) {
      if (!key) {
        key = cdx.split(" {", 1)[0];
      }

      if (++count === LINES_PER_BLOCK) {
        yield await finishChunk();
      }
      cdxLines.push(cdx);
    }

    if (key) {
      yield await finishChunk();
    }
  }

  await fsp.mkdir(indexesDir, { recursive: true });

  const removeIndexFile = async (filename: string) => {
    try {
      await fsp.unlink(path.join(indexesDir, filename));
    } catch (e) {
      // ignore
    }
  };

  const cdxFiles = addDirFiles(warcCdxDir);

  if (!cdxFiles.length) {
    logger.info("No CDXJ files to merge");
    return;
  }

  if (zipped === null) {
    const tempCdxSize = await getDirSize(warcCdxDir);

    // if CDX size is at least this size, use compressed version
    zipped = tempCdxSize >= ZIP_CDX_MIN_SIZE;
  }

  const proc = child_process.spawn("sort", cdxFiles, {
    env: { LC_ALL: "C" },
  });

  if (!zipped) {
    const output = fs.createWriteStream(path.join(indexesDir, INDEX_CDXJ));

    await pipeline(Readable.from(readLinesFrom(proc.stdout)), output);

    await removeIndexFile(INDEX_IDX);
    await removeIndexFile(INDEX_CDX_GZ);
  } else {
    const output = fs.createWriteStream(path.join(indexesDir, INDEX_CDX_GZ));

    const outputIdx = fs.createWriteStream(path.join(indexesDir, INDEX_IDX), {
      encoding: "utf-8",
    });

    await pipeline(
      Readable.from(generateCompressed(readLinesFrom(proc.stdout), outputIdx)),
      output,
    );

    await streamFinish(outputIdx);

    await removeIndexFile(INDEX_CDXJ);
  }
}

// ============================================================================
export class WACZLoader {
  url: string;
  zipreader: ZipRangeReader | null;

  constructor(url: string) {
    this.url = url;
    this.zipreader = null;
  }

  async init() {
    if (!this.url.startsWith("http://") && !this.url.startsWith("https://")) {
      const blob = await openAsBlob(this.url);
      this.url = URL.createObjectURL(blob);
    }

    const loader = await createLoader({ url: this.url });

    this.zipreader = new ZipRangeReader(loader);
  }

  async loadFile(fileInZip: string) {
    const { reader } = await this.zipreader!.loadFile(fileInZip);

    if (!reader) {
      return null;
    }

    if (!reader.iterLines) {
      return new AsyncIterReader(reader);
    }

    return reader;
  }

  async *iterFiles(prefix: string) {
    if (!this.zipreader) {
      await this.init();
    }
    const entries = await this.zipreader!.load();

    for (const [key, value] of Object.entries(entries)) {
      if (key.startsWith(prefix)) {
        yield value;
      }
    }
  }
}
