#!/usr/bin/env node

import yargs from "yargs";
import { logger } from "./util/logger.js";
import { getInfoString } from "./util/file_reader.js";
import { openAsBlob } from "node:fs";
import { WACZLoader } from "./util/wacz.js";
import { ExitCodes } from "./util/constants.js";
import { initRedisWaitForSuccess } from "./util/redis.js";
import { AsyncIterReader } from "warcio";
import { RedisDedupIndex } from "./util/state.js";

export class CrawlIndexer {
  constructor() {}

  initArgs() {
    return yargs(process.argv)
      .usage("indexer [options]")
      .options({
        redisDedupUrl: {
          describe: "URL for remote redis instance to index into",
          type: "string",
          required: true,
        },

        sourceUrl: {
          describe: "Source WACZ or Multi WACZ or Multi WACZ JSON to index",
          type: "string",
          required: true,
        },
      })
      .parseSync();
  }

  async run() {
    logger.setDebugLogging(true);

    process.on("SIGINT", () => this.handleTerminate("SIGINT"));

    process.on("SIGTERM", () => this.handleTerminate("SIGTERM"));

    logger.info(await getInfoString());

    const params = this.initArgs();

    const redis = await initRedisWaitForSuccess(params.redisDedupUrl);
    const dedupIndex = new RedisDedupIndex(redis);

    const allFiles = [];

    for await (const waczfile of this.iterWACZ(params.sourceUrl)) {
      allFiles.push(waczfile);
    }

    let count = 0;
    const total = allFiles.length;

    for (const waczfile of allFiles) {
      count += 1;
      const loader = new WACZLoader(waczfile);
      logger.debug(`Processing WACZ ${count} of ${total}`, { waczfile });
      for await (const file of loader.iterFiles("indexes/")) {
        const filename = file.filename;
        if (filename.endsWith(".cdx.gz")) {
          logger.debug("Processing CDX GZ Index", { filename });
          await this.ingestCDXJ(dedupIndex, loader, filename, "gzip");
        } else if (filename.endsWith(".cdx") || filename.endsWith(".cdxj")) {
          logger.debug("Processing CDX Index", { filename });
          await this.ingestCDXJ(dedupIndex, loader, filename);
        }
      }
    }

    logger.info("Done!");
    process.exit(ExitCodes.Success);
  }

  async ingestCDXJ(
    dedupIndex: RedisDedupIndex,
    loader: WACZLoader,
    filename: string,
    compression?: string,
  ) {
    let reader = await loader.loadFile(filename);

    if (!reader) {
      logger.error("File not found, skipping!");
      return;
    }

    if (compression === "gzip") {
      reader = new AsyncIterReader(reader, "gzip", false);
    }

    let count = 0;

    for await (const line of reader.iterLines()) {
      const inx = line.indexOf(" {");
      if (inx < 0) {
        logger.error("Skipping invalid CDXJ, no JSON", { line });
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cdx: Record<string, any>;

      try {
        cdx = JSON.parse(line.slice(inx));
      } catch (e) {
        logger.error("Skipping invalid CDXJ, JSON invalid", { line });
        continue;
      }

      const date = line.split(" ", 2)[1];
      const url = cdx.url;
      const hash = cdx.digest;

      if (url.startsWith("urn:")) {
        continue;
      }

      // only adding originals to dedup against, don't want to dedup against existing revisits
      if (cdx.mime === "warc/revisit") {
        continue;
      }

      if (url && date && hash) {
        await dedupIndex.addHashDupe(hash, url, date);
      } else {
        logger.warn("Skipping invalid CDXJ, data missing", {
          url,
          date,
          digest: hash,
        });
        continue;
      }

      count += 1;
    }

    logger.debug("Processed", { count });
  }

  async *iterWACZ(url: string): AsyncIterable<string> {
    let path: string = url;

    try {
      path = new URL(url).pathname;
    } catch (e) {
      // ignore
    }

    if (path.endsWith(".wacz")) {
      yield url;
    } else if (path.endsWith(".json")) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        const blob = await openAsBlob(url);
        url = URL.createObjectURL(blob);
      }

      const resp = await fetch(url);
      const json = await resp.json();

      for (const entry of json.resources) {
        if (entry.path) {
          yield* this.iterWACZ(entry.path);
        }
      }
    } else {
      logger.warn("Unknown source", { url }, "replay");
    }
  }

  handleTerminate(signame: string) {
    logger.info(`Got signal ${signame}, exiting`);
    process.exit(ExitCodes.SignalInterrupted);
  }
}

await new CrawlIndexer().run();
