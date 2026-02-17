#!/usr/bin/env node
import yargs from "yargs";
import fs from "fs";
import { formatErr, logger } from "./util/logger.js";
import { getFileOrUrlJson, getInfoString } from "./util/file_reader.js";
import { WACZLoader } from "./util/wacz.js";
import { ExitCodes } from "./util/constants.js";
import { initRedisWaitForSuccess } from "./util/redis.js";
import { RedisDedupeIndex, RedisReportsIndex } from "./util/state.js";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import { CDXJRecord } from "./cdxj.js";

export type DedupeIndexEntry = {
  name: string;
  url: string;
  crawlId?: string;
  size?: number;
  hash?: string;
};

const MIN_UNDUPE_SIZE = 1000;

const TMP_CDX_BUFF = "/tmp/cdxbuff";

const PROMISE_SYNC_BATCH_SIZE = 4096;

export class CrawlIndexer {
  interrupted = false;
  hasUnresolvedRevisits = false;

  initArgs() {
    return yargs(process.argv)
      .usage("indexer [options]")
      .options({
        redisDedupeUrl: {
          describe: "URL for remote redis instance to index into",
          type: "string",
          required: true,
        },

        sourceUrl: {
          describe: "Source WACZ or Multi WACZ or Multi WACZ JSON to index",
          type: "string",
          required: true,
        },

        sourceCrawlId: {
          describe: "If single WACZ, use this id as source id",
          type: "string",
          required: false,
        },

        removing: {
          describe: "If set, also remove unsued crawls/hashes from index",
          type: "boolean",
          required: false,
          default: false,
        },
      })
      .parseSync();
  }

  async run() {
    logger.setDebugLogging(true);

    process.on("SIGINT", () => this.handleInterrupt("SIGINT"));

    process.on("SIGTERM", () => this.handleInterrupt("SIGTERM"));

    logger.info(await getInfoString());

    const params = this.initArgs();

    const redis = await initRedisWaitForSuccess(params.redisDedupeUrl);
    const dedupeIndex = new RedisDedupeIndex(redis, "");
    const reportsIndex = new RedisReportsIndex(redis);

    for await (const entry of this.iterWACZ({
      url: params.sourceUrl,
      name: basename(params.sourceUrl),
      crawlId: params.sourceCrawlId,
    })) {
      await dedupeIndex.queueImportSource(entry.name, JSON.stringify(entry));
      if (entry.crawlId) {
        await dedupeIndex.markNotRemoved(entry.crawlId);
      }
    }

    let res;

    // if removing, scale progress % by half as purge will be second half
    while (
      (res = await dedupeIndex.nextQueuedImportSource(
        params.removing ? 0.5 : 1,
      ))
    ) {
      const { name, entry, done, total } = res;
      const { url, crawlId, size, hash } = JSON.parse(
        entry,
      ) as DedupeIndexEntry;

      logger.debug(`Processing WACZ ${done + 1} of ${total}`, {
        waczfile: url,
      });

      const loader = new WACZLoader(url);

      try {
        await loader.init();
        await loader.zipreader!.load();
      } catch (e) {
        logger.warn("Skipping invalid WACZ file", {
          waczfile: url,
          ...formatErr(e),
        });
        continue;
      }

      const crawlIdReal = crawlId || params.sourceCrawlId || url;

      for await (const file of loader.iterFiles("indexes/")) {
        const filename = file.filename;

        let compress = "";
        let display = "";

        if (filename.endsWith(".cdx.gz")) {
          compress = "gzip";
          display = "CDX GZ";
        } else if (filename.endsWith(".cdx") || filename.endsWith(".cdxj")) {
          compress = "";
          display = "CDX";
        } else {
          continue;
        }

        logger.debug(`Processing ${display} Index`, {
          filename,
        });

        await this.ingestCDXJ(
          dedupeIndex,
          reportsIndex,
          loader,
          filename,
          crawlIdReal,
          compress,
        );
      }

      await dedupeIndex.markImportSourceDone(name, crawlIdReal, {
        filename: name,
        size,
        hash,
      });

      if (this.interrupted) {
        logger.info("Interrupting!");
        process.exit(ExitCodes.SignalInterrupted);
      }
    }

    if (params.removing) {
      await dedupeIndex.purgeUnusedCrawls();
    } else {
      await dedupeIndex.countUnusedCrawls();
    }

    logger.info("Done!");
    await dedupeIndex.markImportFinishedTS();
    process.exit(ExitCodes.Success);
  }

  async ingestCDXJ(
    dedupeIndex: RedisDedupeIndex,
    reportsIndex: RedisReportsIndex,
    loader: WACZLoader,
    filename: string,
    crawlId: string,
    compression: string,
  ) {
    const reader = await loader.loadFile(filename);

    if (!reader) {
      logger.error("File not found, skipping!");
      return;
    }

    // fully read to local buffer first, since CDX files are fairly small
    // to avoid having extra overhead of open connection
    await pipeline(reader, fs.createWriteStream(TMP_CDX_BUFF));

    let nodeStream: Readable = fs.createReadStream(TMP_CDX_BUFF);

    if (compression === "gzip") {
      const gunzip = createGunzip({ chunkSize: 64 * 1024 });
      nodeStream = nodeStream.pipe(gunzip);
    }

    let count = 0;

    const lineStream = readline.createInterface({
      input: nodeStream,
      crlfDelay: Infinity,
    });

    let promises = [];

    for await (const line of lineStream) {
      count += 1;
      const inx = line.indexOf(" {");
      if (inx < 0) {
        logger.error("Skipping invalid CDXJ, no JSON", { line });
        continue;
      }

      if (promises.length >= PROMISE_SYNC_BATCH_SIZE) {
        await Promise.allSettled(promises);
        promises = [];
      }

      if (count % 1000 === 0) {
        logger.debug("Lines processed", { count });
      }

      let cdx: Record<string, never> | CDXJRecord = {};

      try {
        cdx = JSON.parse(line.slice(inx));
      } catch (e) {
        logger.error("Skipping invalid CDXJ, JSON invalid", { line });
        continue;
      }

      const date = line.split(" ", 2)[1];
      const url = cdx.url;
      const hash = cdx.digest;
      const size = Number(cdx.length);

      promises.push(reportsIndex.recordStats(cdx, crawlId));

      if (url.startsWith("urn:")) {
        continue;
      }

      const process = async () => {
        // only adding originals to dedupe against, don't want to dedupe against existing revisits
        if (cdx.mime === "warc/revisit") {
          // check if original is already in index
          const res = await dedupeIndex.getHashDupe(hash);
          let origSize = 0;
          if (res && res.size) {
            origSize = res.size;
          } else {
            this.hasUnresolvedRevisits = true;
          }

          await dedupeIndex.addImportedHashDupe(hash, size, crawlId, origSize);
        } else if (url && date && hash) {
          await dedupeIndex.addImportedHashNew(
            hash,
            url,
            date,
            size,
            crawlId,
            MIN_UNDUPE_SIZE,
          );
          if (this.hasUnresolvedRevisits) {
            await dedupeIndex.matchRevisitSize(hash, size);
          }
        } else {
          logger.warn("Skipping invalid CDXJ, data missing", {
            url,
            date,
            digest: hash,
          });
        }
      };

      promises.push(process());
    }

    if (promises.length) {
      await Promise.allSettled(promises);
    }

    logger.debug("Processed", { count });
  }

  async *iterWACZ(entry: DedupeIndexEntry): AsyncIterable<DedupeIndexEntry> {
    const { url } = entry;
    let path = url;

    try {
      path = new URL(url).pathname;
    } catch (e) {
      // ignore
    }

    if (path.endsWith(".wacz")) {
      yield entry;
    } else if (path.endsWith(".json")) {
      try {
        const json = (await getFileOrUrlJson(url)) as {
          resources: (DedupeIndexEntry & { path: string })[];
        };

        for (const entry of json.resources) {
          entry.url = entry.path;
          yield* this.iterWACZ(entry);
        }
      } catch (e) {
        logger.warn("Error loading from source", { url, ...formatErr(e) });
      }
    } else {
      logger.warn("Unknown source", { url });
    }
  }

  handleInterrupt(signame: string) {
    logger.info(`Got signal ${signame}, interrupting after this file`);
    this.interrupted = true;
  }
}

await new CrawlIndexer().run();
