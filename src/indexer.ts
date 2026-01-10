#!/usr/bin/env node
import yargs from "yargs";
import fs from "fs";
import { formatErr, logger } from "./util/logger.js";
import { getFileOrUrlJson, getInfoString } from "./util/file_reader.js";
import { WACZLoader } from "./util/wacz.js";
import { ExitCodes } from "./util/constants.js";
import { initRedisWaitForSuccess } from "./util/redis.js";
import { RedisDedupeIndex } from "./util/state.js";
import { basename } from "node:path";
import { Readable } from "node:stream";
import readline from "node:readline";
import { createGunzip } from "node:zlib";

export type DedupeIndexEntry = {
  name: string;
  url: string;
  crawlId?: string;
  size?: number;
  hash?: string;
};

const MIN_UNDUPE_SIZE = 1000;

export class CrawlIndexer {
  constructor() {}

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

    process.on("SIGINT", () => this.handleTerminate("SIGINT"));

    process.on("SIGTERM", () => this.handleTerminate("SIGTERM"));

    logger.info(await getInfoString());

    const params = this.initArgs();

    const redis = await initRedisWaitForSuccess(params.redisDedupeUrl);
    const dedupeIndex = new RedisDedupeIndex(redis, "");

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

    let count = 0;
    let res;

    while ((res = await dedupeIndex.nextQueuedImportSource())) {
      const { name, entry, remaining } = res;
      const { url, crawlId, size, hash } = JSON.parse(
        entry,
      ) as DedupeIndexEntry;
      const percent = count / (count + remaining);

      // if removing, scale progress % by half as purge will be second half
      await dedupeIndex.setUpdateProgress(
        percent * (params.removing ? 0.5 : 1),
      );

      const loader = new WACZLoader(url);

      count++;

      logger.debug(`Processing WACZ ${count} of ${remaining + count - 1}`, {
        waczfile: url,
      });

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

        let compress = "",
          display = "";

        if (filename.endsWith(".cdx.gz")) {
          compress = "gzip";
          display = "CDX GZ";
        } else if (filename.endsWith(".cdx")) {
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
          loader,
          filename,
          crawlIdReal,
          compress,
          true,
        );
      }

      await dedupeIndex.markImportSourceDone(name, crawlIdReal, {
        filename: name,
        size,
        hash,
      });
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
    loader: WACZLoader,
    filename: string,
    crawlId: string,
    compression: string,
    commitToAllkey: boolean,
  ) {
    const reader = await loader.loadFile(filename);

    if (!reader) {
      logger.error("File not found, skipping!");
      return;
    }

    const writable = Readable.from(reader).pipe(
      fs.createWriteStream("/tmp/buff"),
    );

    await new Promise<void>((resolve) =>
      writable.on("finish", () => {
        console.log("FULLY READ CDX");
        resolve();
      }),
    );

    //const data = await reader.readFully();

    // if (compression === "gzip") {
    //   reader = new AsyncIterReader(reader, "gzip", false);
    // }

    let nodeStream: Readable = fs.createReadStream("/tmp/buff");

    if (compression === "gzip") {
      const gunzip = createGunzip({ chunkSize: 64 * 1024 });
      nodeStream = nodeStream.pipe(gunzip);
    }

    let count = 0;

    const lineStream = readline.createInterface({
      input: nodeStream,
      // crlfDelay handles both LF ('\n') and CR LF ('\r\n') as single line breaks
      crlfDelay: Infinity,
    });

    //let promises = [];

    for await (const line of lineStream) {
      count += 1;
      const inx = line.indexOf(" {");
      if (inx < 0) {
        logger.error("Skipping invalid CDXJ, no JSON", { line });
        continue;
      }

      // if (promises.length >= 4096) {
      //   await Promise.allSettled(promises);
      //   promises = [];
      // }

      if (count % 1000 === 0) {
        logger.debug("Lines processed", { count });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cdx: Record<string, any> = {};

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

      if (url.startsWith("urn:")) {
        continue;
      }

      const process = async () => {
        // only adding originals to dedupe against, don't want to dedupe against existing revisits
        if (cdx.mime === "warc/revisit") {
          // check if original is already in index
          const res = await dedupeIndex.getHashDupe(hash);
          if (res && res.size) {
            await dedupeIndex.addConservedSizeStat(
              res.size - size,
              crawlId,
              commitToAllkey,
            );
          } else {
            await dedupeIndex.addRevisitSize(hash, size, crawlId);
          }
          await dedupeIndex.addUrlStat(true, crawlId, commitToAllkey);
        } else if (url && date && hash) {
          await dedupeIndex.addHashDupe(
            hash,
            url,
            date,
            size,
            crawlId,
            commitToAllkey,
            MIN_UNDUPE_SIZE,
          );
          await dedupeIndex.matchRevisitSize(
            hash,
            size,
            crawlId,
            commitToAllkey,
          );
          await dedupeIndex.addUrlStat(false, crawlId, commitToAllkey);
        } else {
          logger.warn("Skipping invalid CDXJ, data missing", {
            url,
            date,
            digest: hash,
          });
        }
      };

      //promises.push(process());
      await process();
    }

    // if (promises.length) {
    //   await Promise.allSettled(promises);
    // }

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

  handleTerminate(signame: string) {
    logger.info(`Got signal ${signame}, exiting`);
    process.exit(ExitCodes.SignalInterrupted);
  }
}

await new CrawlIndexer().run();
