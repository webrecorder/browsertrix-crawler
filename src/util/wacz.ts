import path from "path";
import { makeZip, InputWithoutMeta } from "client-zip";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import child_process from "node:child_process";

import { createHash, Hash } from "node:crypto";

import { ReadableStream } from "node:stream/web";
import { getInfoString } from "./file_reader.js";

// ============================================================================
export type WACZInitOpts = {
  input: string[];
  output: string;
  pages: string;
  tempCdxDir: string;
  detectPages: boolean;
  indexFromWARCs: boolean;
  logDirectory: string;

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

  resources: WACZResourceEntry[] = [];
  datapackage: WACZDataPackage | null = null;

  chunkOrFile: (Uint8Array | string)[] = [];
  hasher: Hash = createHash("sha256");

  constructor(config: WACZInitOpts, collDir: string) {
    this.warcs = config.input;
    this.pagesDir = config.pages;
    this.logsDir = config.logDirectory;
    this.tempCdxDir = config.tempCdxDir;
    this.collDir = collDir;
    this.indexesDir = path.join(collDir, "indexes");
  }

  addDirFiles(fullDir: string): string[] {
    const files = fs.readdirSync(fullDir);
    return files.map((name) => path.join(fullDir, name));
  }

  async mergeCDXJ() {
    const cdxFiles = this.addDirFiles(this.tempCdxDir);
    const proc = child_process.spawn("sort", cdxFiles, {
      env: { LC_ALL: "C" },
    });

    const rl = readline.createInterface({ input: proc.stdout });

    async function* readAll() {
      for await (const line of rl) {
        yield line + "\n";
      }
    }

    await fsp.mkdir(this.indexesDir, { recursive: true });

    const output = fs.createWriteStream(
      path.join(this.indexesDir, "index.cdxj"),
    );

    await pipeline(Readable.from(readAll()), output);
  }

  async generate() {
    await this.mergeCDXJ();

    this.datapackage = {
      resources: this.resources,
      created: new Date().toISOString(),
      wacz_version: "1.1.1",
      software: await getInfoString(),
    };

    const files = [
      ...this.warcs,
      ...this.addDirFiles(this.indexesDir),
      ...this.addDirFiles(this.pagesDir),
      ...this.addDirFiles(this.logsDir),
      path.join(this.collDir, "datapackage.json"),
    ];

    let isInFile = false;

    let added = false;

    let currMarker: StartMarker | null = null;

    const zip = makeZip(
      this.iterDirForZip(files),
    ) as ReadableStream<Uint8Array>;

    for await (const chunk of zip) {
      if (chunk instanceof StartMarker) {
        isInFile = true;
        currMarker = chunk;
        added = false;
      } else if (chunk instanceof EndMarker) {
        isInFile = false;
        if (added && currMarker) {
          this.resources.push({
            name: path.basename(currMarker.filename),
            path: currMarker.zipPath,
            bytes: currMarker.size,
            hash: `sha256:${currMarker.hasher.digest("hex")}`,
          });
        }
        currMarker = null;
      } else if (isInFile) {
        if (currMarker) {
          if (!added) {
            this.chunkOrFile.push(currMarker.filename);
            added = true;
          }
          currMarker.hasher.update(chunk);
          this.hasher.update(chunk);
        }
      } else {
        this.chunkOrFile.push(chunk);
        this.hasher.update(chunk);
      }
    }
  }

  async getReadable(): Promise<Readable> {
    async function* iterWACZ(
      chunkOrFile: (Uint8Array | string)[],
    ): AsyncIterable<Uint8Array> {
      for (const entry of chunkOrFile) {
        if (typeof entry === "string") {
          yield* fs.createReadStream(entry);
        } else {
          yield entry;
        }
      }
    }

    return Readable.from(iterWACZ(this.chunkOrFile));
  }

  async writeToFile(filename: string) {
    await pipeline(await this.getReadable(), fs.createWriteStream(filename));
  }

  async *iterDirForZip(files: string[]): AsyncGenerator<InputWithoutMeta> {
    const encoder = new TextEncoder();
    // correctly handles DST
    const hoursOffset = (24 - new Date(0).getHours()) % 24;
    const timezoneOffset = hoursOffset * 60 * 60 * 1000;
    //const timezoneOffset = new Date().getTimezoneOffset() * 60000;

    async function* wrapMarkers(
      start: StartMarker,
      iter: AsyncIterable<Uint8Array>,
      end: EndMarker,
    ) {
      yield start;
      yield* iter;
      yield end;
    }

    for (const filename of files) {
      if (filename.endsWith("datapackage.json")) {
        fs.writeFileSync(filename, JSON.stringify(this.datapackage, null, 2), {
          encoding: "utf-8",
        });
      }

      const input = fs.createReadStream(filename);

      const stat = await fsp.stat(filename);
      const mtime = stat.mtime;
      const size = stat.size;

      const nameStr = filename.slice(this.collDir.length + 1);
      const name = encoder.encode(nameStr);
      const lastModified = new Date(mtime.getTime() + timezoneOffset);

      const start = new StartMarker(filename, nameStr, size);
      const end = new EndMarker();

      yield { input: wrapMarkers(start, input, end), lastModified, name, size };
    }
  }
}
