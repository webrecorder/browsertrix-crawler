import fs from "fs";

import { collectOnlineSeedFile } from "./file_reader.js";
import { logger } from "./logger.js";
import { type CrawlerArgs } from "./argParser.js";
import { ScopedSeed, removeQuotes, type ScopeType } from "./seeds.js";
import { type RedisCrawlState } from "./state.js";

export async function parseSeeds(
  params: CrawlerArgs,
  crawlState?: RedisCrawlState,
): Promise<ScopedSeed[]> {
  let seeds = params.seeds as string[];
  const scopedSeeds: ScopedSeed[] = [];

  // Re-add seedFileDone from serialized state to Redis if present
  if (params.state && params.state.seedFileDone && crawlState) {
    await crawlState.markSeedFileDone();
  }

  let seedFileDone = false;
  if (crawlState) {
    seedFileDone = await crawlState.isSeedFileDone();
  }

  // Re-add any seeds from seed files from serialized state to Redis
  if (
    params.state &&
    params.state.seedFileSeeds &&
    seedFileDone &&
    crawlState
  ) {
    for (const seed of params.state.seedFileSeeds) {
      const scopedSeed: ScopedSeed = JSON.parse(seed);
      await crawlState.addSeedFileSeed(scopedSeed);
    }
  }

  if (params.seedFile && !seedFileDone) {
    let seedFilePath = params.seedFile as string;
    if (
      seedFilePath.startsWith("http://") ||
      seedFilePath.startsWith("https://")
    ) {
      seedFilePath = await collectOnlineSeedFile(seedFilePath);
    }

    const urlSeedFile = fs.readFileSync(seedFilePath, "utf8");
    const urlSeedFileList = urlSeedFile.split("\n");

    if (typeof seeds === "string") {
      seeds = [seeds];
    }

    for (const seed of urlSeedFileList) {
      if (seed) {
        seeds.push(seed);
      }
    }
  }

  const scopeOpts = {
    scopeType: params.scopeType as ScopeType | undefined,
    sitemap: params.sitemap,
    include: params.include,
    exclude: params.exclude,
    depth: params.depth,
    extraHops: params.extraHops,
  };

  for (const seed of seeds) {
    const newSeed = typeof seed === "string" ? { url: seed } : seed;
    newSeed.url = removeQuotes(newSeed.url);

    try {
      const scopedSeed = new ScopedSeed({ ...scopeOpts, ...newSeed });
      scopedSeeds.push(scopedSeed);
      if (params.seedFile && !seedFileDone && crawlState) {
        await crawlState.addSeedFileSeed(scopedSeed);
        logger.debug(
          "Pushed seed file seed to Redis",
          { url: scopedSeed.url },
          "seedFile",
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      logger.error("Failed to create seed", {
        error: e.toString(),
        ...scopeOpts,
        ...newSeed,
      });
      if (params.failOnFailedSeed) {
        logger.fatal(
          "Invalid seed specified, aborting crawl",
          { url: newSeed.url },
          "general",
          1,
        );
      }
    }
  }

  // If seed file was already successfully parsed, re-add seeds from Redis
  if (params.seedFile && seedFileDone && crawlState) {
    const seedFileScopedSeeds = await crawlState.getSeedFileSeeds();
    for (const seed of seedFileScopedSeeds) {
      logger.debug(
        "Pulled seed file seed from Redis",
        { url: seed.url },
        "seedFile",
      );
      try {
        const scopedSeed = new ScopedSeed({ ...scopeOpts, url: seed.url });
        scopedSeeds.push(scopedSeed);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        logger.error("Failed to create seed from Redis", {
          error: e.toString(),
          ...seed,
        });
      }
    }
  }

  if (!params.qaSource && !scopedSeeds.length) {
    logger.fatal("No valid seeds specified, aborting crawl");
  }

  if (params.seedFile && crawlState) {
    await crawlState.markSeedFileDone();
  }

  return scopedSeeds;
}
