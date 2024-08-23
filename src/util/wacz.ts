import path, { basename } from "node:path";
import fs from "node:fs";
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

const DATAPACKAGE_JSON = "datapackage.json";
const DATAPACKAGE_DIGEST_JSON = "datapackage-digest.json";

const LINES_PER_BLOCK = 256;

const ZIP_CDX_SIZE = 50_000;

// ============================================================================
export type WACZInitOpts = {
  input: string[];
  output: string;
  pages: string;
  tempCdxDir: string;
  indexesDir: string;
  logDirectory: string;

  softwareString: string;

  signingUrl?: string;
  signingToken?: string;
  title?: string;
  description?: string;
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
};

type WACZDigest = {
  path: string;
  hash: string;
  signedData?: string;
};

class StartMarker extends Uint8Array {
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

class EndMarker extends Uint8Array {
  // empty array to mark end of WACZ file
}

// ============================================================================
export class WACZ {
  collDir: string;

  warcs: string[];

  pagesDir: string;
  logsDir: string;
  tempCdxDir: string;
  indexesDir: string;

  datapackage: WACZDataPackage;

  signingUrl: string | null;
  signingToken: string | null;

  private size = 0;
  private hash: string = "";

  constructor(config: WACZInitOpts, collDir: string) {
    this.warcs = config.input;
    this.pagesDir = config.pages;
    this.logsDir = config.logDirectory;
    this.tempCdxDir = config.tempCdxDir;
    this.collDir = collDir;
    this.indexesDir = config.indexesDir;

    this.datapackage = {
      resources: [],
      created: new Date().toISOString(),
      wacz_version: "1.1.1",
      software: config.softwareString,
    };

    if (config.title) {
      this.datapackage.title = config.title;
    }
    if (config.description) {
      this.datapackage.description = config.description;
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
      let isInFile = false;

      let currMarker: StartMarker | null = null;

      for await (const chunk of zip) {
        if (chunk instanceof StartMarker) {
          isInFile = true;
          currMarker = chunk;
        } else if (chunk instanceof EndMarker) {
          isInFile = false;
          if (currMarker) {
            // Frictionless data validation requires this to be lowercase
            const name = basename(currMarker.filename).toLowerCase();
            const path = currMarker.zipPath;
            const bytes = currMarker.size;
            const hash = "sha256:" + currMarker.hasher.digest("hex");
            resources.push({ name, path, bytes, hash });
            logger.debug("Added file to WACZ", { path, bytes, hash }, "wacz");
          }
          currMarker = null;
        } else if (isInFile) {
          if (currMarker) {
            yield chunk;
            currMarker.hasher.update(chunk);
            hasher.update(chunk);
            size += chunk.length;
          }
        } else {
          yield chunk;
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

  async generateToFile(filename: string) {
    await pipeline(this.generate(), fs.createWriteStream(filename));
  }

  async *iterDirForZip(files: string[]): AsyncGenerator<InputWithoutMeta> {
    const encoder = new TextEncoder();
    const end = new EndMarker();
    // correctly handles DST
    const hoursOffset = (24 - new Date(0).getHours()) % 24;
    const timezoneOffset = hoursOffset * 60 * 60 * 1000;
    //const timezoneOffset = new Date().getTimezoneOffset() * 60000;

    async function* wrapMarkers(
      start: StartMarker,
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
      const mtime = stat.mtime;
      const size = stat.size;

      const nameStr = filename.slice(this.collDir.length + 1);
      const name = encoder.encode(nameStr);
      const lastModified = new Date(mtime.getTime() + timezoneOffset);

      const start = new StartMarker(filename, nameStr, size);

      yield { input: wrapMarkers(start, input), lastModified, name, size };
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
        const response = await fetch(this.signingUrl, {
          method: "POST",
          headers,
          body,
        });
        digest.signedData = await response.json();
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

export async function mergeCDXJ(tempCdxDir: string, indexesDir: string) {
  async function* readAll(rl: readline.Interface): AsyncGenerator<string> {
    for await (const line of rl) {
      yield line + "\n";
    }
  }

  async function* generateCompressed(
    reader: AsyncGenerator<string>,
    idxFile: Writable,
  ) {
    let offset = 0;

    const encoder = new TextEncoder();

    const filename = "index.cdx.gz";

    let cdxLines: string[] = [];

    let key = "";
    let count = 0;

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

  const idxSize = await getDirSize(tempCdxDir);

  const cdxFiles = addDirFiles(tempCdxDir);

  const proc = child_process.spawn("sort", cdxFiles, {
    env: { LC_ALL: "C" },
  });

  const rl = readline.createInterface({ input: proc.stdout });

  const reader = readAll(rl);

  // if indexes are less than this size, use uncompressed version
  if (idxSize < ZIP_CDX_SIZE) {
    const output = fs.createWriteStream(path.join(indexesDir, "index.cdxj"));

    await pipeline(Readable.from(reader), output);

    await removeIndexFile("index.idx");
    await removeIndexFile("index.cdx.gz");
  } else {
    const output = fs.createWriteStream(path.join(indexesDir, "index.cdx.gz"));

    const outputIdx = fs.createWriteStream(path.join(indexesDir, "index.idx"));

    await pipeline(
      Readable.from(generateCompressed(reader, outputIdx)),
      output,
    );

    await streamFinish(outputIdx);

    await removeIndexFile("index.cdxj");
  }
}
