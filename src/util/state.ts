import { Redis, Result, Callback, type ChainableCommander } from "ioredis";
import { v4 as uuidv4 } from "uuid";

import { logger } from "./logger.js";

import {
  MAX_DEPTH,
  DEFAULT_MAX_RETRIES,
  ROBOTS_CACHE_LIMIT,
  DUPE_ALL_HASH_KEY,
  DUPE_ALL_CRAWLS,
  DUPE_ALL_COUNTS,
} from "./constants.js";
import { ScopedSeed } from "./seeds.js";
import { Frame } from "puppeteer-core";
import { interpolateFilename, UploadResult } from "./storage.js";
import normalizeUrl, { Options as NormamlizeUrlOptions } from "normalize-url";
import { WACZ } from "./wacz.js";

// ============================================================================
export enum LoadState {
  FAILED = 0,
  CONTENT_LOADED = 1,
  FULL_PAGE_LOADED = 2,
  EXTRACTION_DONE = 3,
  BEHAVIORS_DONE = 4,
}

// ============================================================================
export enum QueueState {
  ADDED = 0,
  LIMIT_HIT = 1,
  DUPE_URL = 2,
}

// ============================================================================
const normalizeUrlOpts: NormamlizeUrlOptions = {
  defaultProtocol: "https",
  stripAuthentication: false,
  stripTextFragment: false,
  stripWWW: false,
  stripHash: false,
  removeTrailingSlash: false,
  removeSingleSlash: false,
  removeExplicitPort: false,
  sortQueryParameters: true,
  removePath: false,
};

// ============================================================================
// treat 0 or 206 as 200 for purposes of dedup
export function normalizeDedupeStatus(status: number): string {
  if (status === 0 || status === 206) {
    return "200";
  }
  return status + "";
}

// ============================================================================
export type WorkerId = number;

// ============================================================================
export type QueueEntry = {
  added?: string;
  url: string;
  seedId: number;
  depth: number;
  extraHops: number;
  ts?: number;
  pageid?: string;
  retry?: number;
};

// ============================================================================
export type ExtraRedirectSeed = {
  newUrl: string;
  origSeedId: number;
};

// ============================================================================
export type PageCallbacks = {
  addLink?: (url: string) => Promise<void>;
};

// ============================================================================
export class PageState {
  url: string;
  seedId: number;
  depth: number;
  extraHops: number;
  retry: number;

  status: number;

  workerid!: WorkerId;

  pageid: string;
  title?: string;
  mime?: string;
  ts?: Date;

  callbacks: PageCallbacks = {};

  isHTMLPage = true;
  text?: string;
  screenshotView?: Buffer;
  favicon?: string;

  skipBehaviors = false;
  pageSkipped = false;
  noRetries = false;

  asyncLoading = false;
  filteredFrames: Frame[] = [];
  loadState: LoadState = LoadState.FAILED;
  contentCheckAllowed = false;

  logDetails = {};

  constructor(redisData: QueueEntry) {
    this.url = redisData.url;
    this.seedId = redisData.seedId;
    this.depth = redisData.depth;
    this.extraHops = redisData.extraHops || 0;
    if (redisData.ts) {
      this.ts = new Date(redisData.ts);
    }
    this.pageid = redisData.pageid || uuidv4();
    this.status = 0;
    this.retry = redisData.retry || 0;
  }
}

// ============================================================================
declare module "ioredis" {
  interface RedisCommander<Context> {
    numfound(
      skey: string,
      esKey: string,
      exKey: string,
    ): Result<number, Context>;

    addqueue(
      pkey: string,
      qkey: string,
      skey: string,
      esKey: string,
      exKey: string,
      url: string,
      score: number,
      data: string,
      limit: number,
    ): Result<number, Context>;

    trimqueue(
      qkey: string,
      pkey: string,
      skey: string,
      limit: number,
    ): Result<number, Context>;

    getnext(qkey: string, pkey: string): Result<string, Context>;

    markstarted(
      pkey: string,
      pkeyUrl: string,
      url: string,
      started: string,
      maxPageTime: number,
      uid: string,
    ): Result<void, Context>;

    unlockpending(
      pkeyUrl: string,
      uid: string,
      callback?: Callback<string>,
    ): Result<void, Context>;

    requeue(
      pkey: string,
      qkey: string,
      pkeyUrl: string,
      url: string,
      maxRetries: number,
      maxRegularDepth: number,
    ): Result<number, Context>;

    requeuefailed(
      pkey: string,
      qkey: string,
      fkey: string,
      url: string,
      maxRetries: number,
      maxRegularDepth: number,
    ): Result<number, Context>;

    addnewseed(
      esKey: string,
      esMap: string,
      skey: string,
      url: string,
      seedData: string,
    ): Result<number, Context>;
  }
}

// ============================================================================
export type SaveState = {
  done?: number | string[];
  finished: string[];
  queued: string[];
  pending: string[];
  failed: string[];
  errors: string[];
  extraSeeds: string[];
  sitemapDone: boolean;
  excluded?: string[];
};

// ============================================================================
export type DedupeEntry = {
  origDate: string;
  origUrl: string;
  index: string;
  crawlId: string;
  size: number;
};

// ============================================================================
export type DedupeSourceEntry = {
  filename: string;
  size?: number;
  hash?: string;
};

// ============================================================================
export class RedisDedupeIndex {
  dedupeRedis: Redis;
  crawlId: string;
  dedupeKeyIndex = 0;
  dedupeCurrFilename = "";

  sourceDone = "src:d";
  sourceQ = "src:q";
  sourceQSet = "src:qset";
  pendingQ = "pending:q";
  sourceP = "src:p";
  pendingPrefix = "pending:q:";

  noremove = "noremove:" + Date.now();

  constructor(dedupeRedis: Redis, crawlId: string) {
    this.dedupeRedis = dedupeRedis;
    this.crawlId = crawlId;
  }

  // DEDUPE SOURCE WACZ (to track dependencies)

  async addSourceWACZForDedupe(filename: string) {
    const crawlId = this.crawlId;
    const count =
      (await this.dedupeRedis.rpush(
        `c:${crawlId}:wacz`,
        JSON.stringify({ filename }),
      )) - 1;
    this.dedupeCurrFilename = filename;
    this.dedupeKeyIndex = count;
  }

  async updateDedupeSourceWACZ(wacz: WACZ) {
    const value: DedupeSourceEntry = {
      filename: wacz.getLocalFilename() || this.dedupeCurrFilename,
      hash: wacz.getHash(),
      size: wacz.getSize(),
    };

    const crawlId = this.crawlId;
    const pipe = this.dedupeRedis.pipeline();
    pipe.lset(`c:${crawlId}:wacz`, this.dedupeKeyIndex, JSON.stringify(value));

    if (value.size) {
      this.incrTotalSize(pipe, `h:${crawlId}:counts`, value.size);
    }

    await pipe.exec();
  }

  // COMMIT DEDUPE TO SHARED INDEX

  async commitDedupeDone(crawlId?: string) {
    crawlId = crawlId || this.crawlId;
    for await (const hashes of this.dedupeRedis.hscanStream(`h:${crawlId}`)) {
      let isValue = false;
      for (const hash of hashes) {
        if (!isValue) {
          await this.dedupeRedis.hsetnx(DUPE_ALL_HASH_KEY, hash, crawlId);
        }
        isValue = !isValue;
      }
    }

    // commit imported waczs list
    const numWacz = await this.dedupeRedis.llen(`c:${crawlId}:wacz`);

    for (let i = 0; i < numWacz; i++) {
      const waczdata = await this.dedupeRedis.lindex(`c:${crawlId}:wacz`, i);
      if (!waczdata) {
        continue;
      }
      try {
        const { filename } = JSON.parse(waczdata);
        await this.dedupeRedis.sadd(this.sourceDone, filename);
      } catch (e) {
        // ignore
      }
    }

    // add to crawls list
    await this.dedupeRedis.sadd(DUPE_ALL_CRAWLS, crawlId);

    // add counts
    await this.addCrawlCounts(crawlId);
  }

  // GET OR ADD INDIVIDUAL HASHES

  async getHashDupe(hash: string): Promise<DedupeEntry | null> {
    hash = hash.split(":").at(-1)!;

    // first, check the shared key
    let crawlId = await this.dedupeRedis.hget(DUPE_ALL_HASH_KEY, hash);
    if (!crawlId) {
      // otherwise, try current crawl
      crawlId = this.crawlId;
    }
    const value = await this.dedupeRedis.hget(`h:${crawlId}`, hash);
    if (!value) {
      return null;
    }
    const val = value.split(" ");
    return {
      origUrl: val[2],
      origDate: val[1],
      index: val[0],
      size: Number(val[3]),
      crawlId,
    };
  }

  getHashValue(hash: string, url: string, date: string, size: number) {
    url = normalizeUrl(url, normalizeUrlOpts);
    date = date.replace(/[^\d]/g, "");
    const key = hash.split(":").at(-1)!;
    const val = `${this.dedupeKeyIndex} ${date} ${url} ${size}`;
    return { key, val };
  }

  async addHashDupe(
    hash: string,
    url: string,
    date: string,
    size: number,
    origRecSize: number,
  ) {
    // optimized addHashDupe into single pipeline
    const pipe = this.dedupeRedis.pipeline();

    const rootKey = `h:${this.crawlId}`;
    const statsKey = rootKey + ":counts";

    if (!origRecSize) {
      const { key, val } = this.getHashValue(hash, url, date, size);
      pipe.hsetnx(rootKey, key, val);
    } else {
      pipe.hincrby(statsKey, "dupeUrls", 1);
    }
    pipe.hincrby(statsKey, "totalUrls", 1);

    if (origRecSize && origRecSize > size) {
      this.incrConservedSize(pipe, statsKey, origRecSize - size);
    }

    await pipe.exec();
  }

  // COUNT STATS
  incrConservedSize(pipe: ChainableCommander, key: string, value: number) {
    pipe.hincrby(key, "conservedSize", value);
  }

  incrTotalSize(pipe: ChainableCommander, key: string, value: number) {
    pipe.hincrby(key, "totalCrawlSize", value);
  }

  async addCrawlCounts(crawlId: string) {
    const counts = await this.dedupeRedis.hgetall(`h:${crawlId}:counts`);
    for (const [key, value] of Object.entries(counts)) {
      await this.dedupeRedis.hincrby(DUPE_ALL_COUNTS, key, Number(value));
    }
  }

  // IMPORT

  async matchRevisitSize(hash: string, origSize: number) {
    const sizeEntries = await this.dedupeRedis.lrange(`rev:${hash}`, 0, -1);

    if (!sizeEntries.length) {
      return;
    }

    const incrMap: Record<string, number> = {};

    for (const entry of sizeEntries) {
      const { size, crawlId } = JSON.parse(entry);
      incrMap[crawlId] = (incrMap[crawlId] || 0) + origSize - size;
    }

    const pipe = this.dedupeRedis.pipeline();

    for (const [crawlId, value] of Object.entries(incrMap)) {
      this.incrConservedSize(pipe, `h:${crawlId}:counts`, value);
      this.incrConservedSize(pipe, DUPE_ALL_COUNTS, value);
    }

    pipe.del(`rev:${hash}`);

    await pipe.exec();
  }

  async queueImportSource(id: string, data: string) {
    // already handled this source
    if (await this.dedupeRedis.sismember(this.sourceDone, id)) {
      return;
    }
    if (!(await this.dedupeRedis.sadd(this.sourceQSet, id))) {
      return;
    }
    await this.dedupeRedis.lpush(this.sourceQ, data);
  }

  async addImportedHashNew(
    hash: string,
    url: string,
    date: string,
    size: number,
    crawlId: string,
    minUndupedSizeTrack = 0,
  ) {
    const { key, val } = this.getHashValue(hash, url, date, size);

    const isNew = await this.dedupeRedis.hsetnx(
      DUPE_ALL_HASH_KEY,
      key,
      crawlId,
    );

    const pipe = this.dedupeRedis.pipeline();

    // always attempt to set for current crawl even in already set in other crawls
    pipe.hsetnx(`h:${crawlId}`, key, val);

    // track "redundant" size
    if (!isNew && minUndupedSizeTrack && size > minUndupedSizeTrack) {
      pipe.hincrby(
        DUPE_ALL_COUNTS,
        "estimatedRedundantSize",
        size - minUndupedSizeTrack,
      );
    }

    pipe.hincrby(`h:${crawlId}:counts`, "totalUrls", 1);
    pipe.hincrby(DUPE_ALL_COUNTS, "totalUrls", 1);

    await pipe.exec();
  }

  async addImportedHashDupe(
    hash: string,
    size: number,
    crawlId: string,
    origRecSize: number,
  ) {
    const statsKey = `h:${crawlId}:counts`;
    const pipe = this.dedupeRedis.pipeline();

    // if orig revisit is known
    if (origRecSize) {
      if (origRecSize > size) {
        this.incrConservedSize(pipe, statsKey, origRecSize - size);
        this.incrConservedSize(pipe, DUPE_ALL_COUNTS, origRecSize - size);
      }
    } else {
      // otherwise queue for later resolve
      pipe.lpush(`rev:${hash}`, JSON.stringify({ size, crawlId }));
    }

    pipe.hincrby(statsKey, "dupeUrls", 1);
    pipe.hincrby(statsKey, "totalUrls", 1);
    pipe.hincrby(DUPE_ALL_COUNTS, "dupeUrls", 1);
    pipe.hincrby(DUPE_ALL_COUNTS, "totalUrls", 1);

    await pipe.exec();
  }

  async markImportSourceDone(
    id: string,
    crawlId: string,
    entry: DedupeSourceEntry,
  ) {
    const pipe = this.dedupeRedis.pipeline();

    pipe.sadd(this.sourceDone, id);
    pipe.sadd(DUPE_ALL_CRAWLS, crawlId);
    pipe.rpush(`c:${crawlId}:wacz`, JSON.stringify(entry));

    if (entry.size) {
      this.incrTotalSize(pipe, `h:${crawlId}:counts`, entry.size);
      this.incrTotalSize(pipe, DUPE_ALL_COUNTS, entry.size);
    }

    await pipe.exec();
  }

  async nextQueuedImportSource() {
    let res: string | null = await this.dedupeRedis.lmove(
      this.sourceQ,
      this.pendingQ,
      "RIGHT",
      "LEFT",
    );
    // use circular pending Q to support retries
    if (!res) {
      const len = await this.dedupeRedis.llen(this.pendingQ);
      for (let i = 0; i < len; i++) {
        res = await this.dedupeRedis.lmove(
          this.pendingQ,
          this.pendingQ,
          "RIGHT",
          "LEFT",
        );
        if (res) {
          const { id } = JSON.parse(res);
          if (await this.dedupeRedis.get(this.pendingPrefix + id)) {
            res = null;
            continue;
          } else {
            break;
          }
        }
      }
    }

    if (!res) {
      return null;
    }

    await this.dedupeRedis.lrem(this.pendingQ, 1, res);
    const { name } = JSON.parse(res);
    await this.dedupeRedis.srem(this.sourceQSet, name);
    const remaining = (await this.dedupeRedis.llen(this.sourceQ)) + 1;
    await this.dedupeRedis.setex(this.pendingPrefix + name, "1", 300);
    return { name, entry: res, remaining };
  }

  async setUpdateProgress(percent: number) {
    await this.dedupeRedis.hset(DUPE_ALL_COUNTS, "updateProgress", percent);
  }

  async markImportFinishedTS() {
    await this.dedupeRedis.hset(DUPE_ALL_COUNTS, "updateProgress", "1");
    await this.dedupeRedis.set("last_update_ts", new Date().toISOString());
  }

  // REMOVE ON IMPORT

  async markNotRemoved(crawlId: string) {
    await this.dedupeRedis.sadd(this.noremove, crawlId);
  }

  async purgeUnusedCrawls() {
    const noRemoveSet = new Set<string>(
      await this.dedupeRedis.smembers(this.noremove),
    );

    await this.clearAndReadd(noRemoveSet);

    await this.dedupeRedis.del(this.noremove);
  }

  async countUnusedCrawls() {
    const removable = await this.dedupeRedis.sdiff(
      DUPE_ALL_CRAWLS,
      this.noremove,
    );

    await this.dedupeRedis.del(this.noremove);

    let total = 0;

    for (const crawlId of removable) {
      const res = await this.dedupeRedis.hget(
        `h:${crawlId}:counts`,
        "totalCrawlSize",
      );
      const size = parseInt(res || "");
      if (!isNaN(size)) {
        total += size;
      }
    }

    await this.dedupeRedis.hset(
      DUPE_ALL_COUNTS,
      "removedCrawls",
      removable.length,
    );
    await this.dedupeRedis.hset(DUPE_ALL_COUNTS, "removedCrawlSize", total);
  }

  async clearAndReadd(readdCrawls: Set<string>) {
    const TO_REMOVE_CRAWLS = "to-remove-crawls";

    await this.dedupeRedis.rename(DUPE_ALL_CRAWLS, TO_REMOVE_CRAWLS);
    await this.dedupeRedis.del(DUPE_ALL_HASH_KEY);
    await this.dedupeRedis.del(DUPE_ALL_COUNTS);

    const numCrawls = readdCrawls.size;
    let count = 0;

    // readd all crawls that should be kept
    for (const crawlId of readdCrawls) {
      await this.setUpdateProgress(0.5 + 0.5 * (count++ / numCrawls));
      await this.commitDedupeDone(crawlId);
      await this.dedupeRedis.srem(TO_REMOVE_CRAWLS, crawlId);
    }

    // clear data for remaining
    while (true) {
      const crawlId = await this.dedupeRedis.spop(TO_REMOVE_CRAWLS);
      if (!crawlId) {
        break;
      }
      while (true) {
        const waczdata = await this.dedupeRedis.lpop(`c:${crawlId}:wacz`);
        if (!waczdata) {
          break;
        }
        try {
          const { filename } = JSON.parse(waczdata);
          await this.dedupeRedis.srem(this.sourceDone, filename);
        } catch (e) {
          // ignore
        }
      }
      await this.dedupeRedis.del(
        `h:${crawlId}`,
        `c:${crawlId}:wacz`,
        `h:${crawlId}:counts`,
      );
    }

    await this.dedupeRedis.del(TO_REMOVE_CRAWLS);
  }
}

// ============================================================================
export class RedisCrawlState extends RedisDedupeIndex {
  redis: Redis;
  maxRetries: number;

  uid: string;
  maxPageTime: number;

  qkey: string;
  pkey: string;
  skey: string;
  dkey: string;
  fkey: string;
  ekey: string;
  bkey: string;
  rkey: string;
  lkey: string;
  pageskey: string;

  esKey: string;
  esMap: string;

  exKey: string;

  sitemapDoneKey: string;

  waczFilename: string | null = null;

  constructor(
    redis: Redis,
    key: string,
    maxPageTime: number,
    uid: string,
    maxRetries?: number,
    dedupeRedis?: Redis,
  ) {
    super(dedupeRedis || redis, key);
    this.redis = redis;

    this.uid = uid;
    this.maxPageTime = maxPageTime;
    this.maxRetries = maxRetries ?? DEFAULT_MAX_RETRIES;

    this.qkey = this.crawlId + ":q";
    this.pkey = this.crawlId + ":p";
    this.skey = this.crawlId + ":s";
    // done (integer)
    this.dkey = this.crawlId + ":d";
    // failed final, no more retry
    this.fkey = this.crawlId + ":f";
    // crawler errors
    this.ekey = this.crawlId + ":e";
    // crawler behavior script messages
    this.bkey = this.crawlId + ":b";
    // cached robots.txt bodies (per-origin)
    this.rkey = this.crawlId + ":r";
    // LRU cache of robots.txt keys
    this.lkey = this.crawlId + ":l";
    // pages
    this.pageskey = this.crawlId + ":pages";

    this.esKey = this.crawlId + ":extraSeeds";
    this.esMap = this.crawlId + ":esMap";

    // stores URLs that have been seen but excluded
    // (eg. redirect-to-excluded or trimmed)
    this.exKey = this.crawlId + ":excluded";

    this.sitemapDoneKey = this.crawlId + ":sitemapDone";

    this._initLuaCommands(this.redis);
  }

  _initLuaCommands(redis: Redis) {
    redis.defineCommand("numfound", {
      numberOfKeys: 3,
      lua: `
return redis.call('scard', KEYS[1]) - redis.call('llen', KEYS[2]) - redis.call('scard', KEYS[3]);
`,
    });

    redis.defineCommand("addqueue", {
      numberOfKeys: 5,
      lua: `
local size = redis.call('scard', KEYS[3]) - redis.call('llen', KEYS[4]) - redis.call('scard', KEYS[5]);
local limit = tonumber(ARGV[4]);
if limit > 0 and size >= limit then
  return 1;
end
if redis.call('sadd', KEYS[3], ARGV[1]) == 0 then
  return 2;
end
redis.call('zadd', KEYS[2], ARGV[2], ARGV[3]);
redis.call('hdel', KEYS[1], ARGV[1]);
return 0;
`,
    });

    redis.defineCommand("trimqueue", {
      numberOfKeys: 3,
      lua: `
      local limit = tonumber(ARGV[1]);
      if redis.call('zcard', KEYS[1]) <= limit then
        return 0
      end
      local res = redis.call('zpopmax', KEYS[1]);
      local json = res[1];

      if json then
        local data = cjson.decode(json);
        redis.call('hdel', KEYS[2], data.url);
        redis.call('sadd', KEYS[3], data.url);
      end
      return 1;
      `,
    });

    redis.defineCommand("getnext", {
      numberOfKeys: 2,
      lua: `
local res = redis.call('zpopmin', KEYS[1]);
local json = res[1]

if json then
  local data = cjson.decode(json);
  redis.call('hset', KEYS[2], data.url, json);
end

return json;
`,
    });

    redis.defineCommand("markstarted", {
      numberOfKeys: 2,
      lua: `
local json = redis.call('hget', KEYS[1], ARGV[1]);

if json then
  local data = cjson.decode(json);
  data['started'] = ARGV[2];
  json = cjson.encode(data);
  redis.call('hset', KEYS[1], ARGV[1], json);
  redis.call('setex', KEYS[2], ARGV[3], ARGV[4]);
end

`,
    });

    redis.defineCommand("unlockpending", {
      numberOfKeys: 1,
      lua: `
local value = redis.call('get', KEYS[1]);

if value == ARGV[1] then
  redis.call('del', KEYS[1])
end

`,
    });

    redis.defineCommand("requeuefailed", {
      numberOfKeys: 3,
      lua: `
local json = redis.call('hget', KEYS[1], ARGV[1]);

if json then
  local data = cjson.decode(json);
  local retry = data['retry'] or 0;

  redis.call('hdel', KEYS[1], ARGV[1]);

  if retry < tonumber(ARGV[2]) then
    retry = retry + 1;
    data['retry'] = retry;
    json = cjson.encode(data);
    local score = (data['depth'] or 0) + ((data['extraHops'] or 0) * ARGV[3]) + (retry * ARGV[3] * 2);
    redis.call('zadd', KEYS[2], score, json);
    return retry;
  else
    redis.call('lpush', KEYS[3], json);
  end
end
return -1;

`,
    });

    redis.defineCommand("requeue", {
      numberOfKeys: 3,
      lua: `
local res = redis.call('get', KEYS[3]);
if not res then
  local json = redis.call('hget', KEYS[1], ARGV[1]);
  if json then
    local data = cjson.decode(json);
    local retry = data['retry'] or 0;

    redis.call('hdel', KEYS[1], ARGV[1]);

    if retry < tonumber(ARGV[2]) then
      retry = retry + 1;
      data['retry'] = retry;
      json = cjson.encode(data);
      local score = (data['depth'] or 0) + ((data['extraHops'] or 0) * ARGV[3]) + (retry * ARGV[3] * 2);
      redis.call('zadd', KEYS[2], score, json);
      return 1;
    else
      return 2;
    end
  end
end
return 0;
`,
    });

    redis.defineCommand("addnewseed", {
      numberOfKeys: 3,
      lua: `
local res = redis.call('hget', KEYS[2], ARGV[2]);
if res then
    return tonumber(res);
end

local inx = redis.call('lpush', KEYS[1], ARGV[1]) - 1;
redis.call('hset', KEYS[2], ARGV[2], tostring(inx));
redis.call('sadd', KEYS[3], ARGV[2]);
return inx;
`,
    });
  }

  async _getNext() {
    return await this.redis.getnext(this.qkey, this.pkey);
  }

  _timestamp() {
    return new Date().toISOString();
  }

  async markStarted(url: string) {
    const started = this._timestamp();

    return await this.redis.markstarted(
      this.pkey,
      this.pkey + ":" + url,
      url,
      started,
      this.maxPageTime,
      this.uid,
    );
  }

  async markFinished(url: string) {
    await this.redis.hdel(this.pkey, url);

    return await this.redis.incr(this.dkey);
  }

  async markFailed(url: string, noRetries = false) {
    return await this.redis.requeuefailed(
      this.pkey,
      this.qkey,
      this.fkey,
      url,
      noRetries ? 0 : this.maxRetries,
      MAX_DEPTH,
    );
  }

  async markExcluded(url: string) {
    await this.redis.hdel(this.pkey, url);

    await this.redis.sadd(this.exKey, url);
  }

  recheckScope(data: QueueEntry, seeds: ScopedSeed[]) {
    const seed = seeds[data.seedId];

    return seed.isIncluded(data.url, data.depth, data.extraHops);
  }

  async isFinished() {
    return (await this.queueSize()) == 0 && (await this.numDone()) > 0;
  }

  async isFailed() {
    return (
      (await this.numDone()) === 0 &&
      (await this.queueSize()) === 0 &&
      (await this.numPending()) === 0 &&
      (await this.numFailed()) > 0
    );
  }

  async numFound() {
    return await this.redis.numfound(this.skey, this.esKey, this.exKey);
  }

  async trimToLimit(limit: number) {
    if (limit === 0) {
      return;
    }

    const totalComplete =
      (await this.numPending()) +
      (await this.numDone()) +
      (await this.numFailed());
    if (!totalComplete) {
      return;
    }
    const remain = Math.max(0, limit - totalComplete);
    // trim queue until size <= remain
    while (
      (await this.redis.trimqueue(this.qkey, this.pkey, this.exKey, remain)) ===
      1
    ) {
      /* ignore */
    }
  }

  async setFailReason(reason: string) {
    await this.redis.set(`${this.crawlId}:failReason`, reason);
  }

  async setStatus(status_: string) {
    await this.redis.hset(`${this.crawlId}:status`, this.uid, status_);
  }

  async getStatus(): Promise<string> {
    return (await this.redis.hget(`${this.crawlId}:status`, this.uid)) || "";
  }

  async setWACZFilename(): Promise<string> {
    const filename = process.env.STORE_FILENAME || "@ts-@id.wacz";
    this.waczFilename = interpolateFilename(filename, this.crawlId);
    if (
      !(await this.redis.hsetnx(
        `${this.crawlId}:nextWacz`,
        this.uid,
        this.waczFilename,
      ))
    ) {
      this.waczFilename = await this.redis.hget(
        `${this.crawlId}:nextWacz`,
        this.uid,
      );
      logger.debug(
        "Keeping WACZ Filename",
        { filename: this.waczFilename },
        "state",
      );
    } else {
      logger.debug(
        "Using New WACZ Filename",
        { filename: this.waczFilename },
        "state",
      );
    }
    return this.waczFilename!;
  }

  async getWACZFilename(): Promise<string> {
    if (!this.waczFilename) {
      return await this.setWACZFilename();
    }
    return this.waczFilename;
  }

  async clearWACZFilename(): Promise<void> {
    await this.redis.hdel(`${this.crawlId}:nextWacz`, this.uid);
    this.waczFilename = null;
  }

  async setArchiveSize(size: number) {
    return await this.redis.hset(`${this.crawlId}:size`, this.uid, size);
  }

  async isCrawlStopped() {
    if ((await this.redis.get(`${this.crawlId}:stopping`)) === "1") {
      return true;
    }

    if ((await this.redis.hget(`${this.crawlId}:stopone`, this.uid)) === "1") {
      return true;
    }

    return false;
  }

  async isCrawlPaused() {
    if ((await this.redis.get(`${this.crawlId}:paused`)) === "1") {
      return true;
    }

    return false;
  }

  async isCrawlCanceled() {
    return (await this.redis.get(`${this.crawlId}:canceled`)) === "1";
  }

  // note: not currently called in crawler, but could be
  // crawl may be stopped by setting this elsewhere in shared redis
  async stopCrawl() {
    await this.redis.set(`${this.crawlId}:stopping`, "1");
  }

  async processMessage(seeds: ScopedSeed[]) {
    while (true) {
      const result = await this.redis.lpop(`${this.uid}:msg`);
      if (!result) {
        return;
      }
      try {
        const { type, regex } = JSON.parse(result);
        switch (type) {
          case "addExclusion":
            logger.debug("Add Exclusion", { type, regex }, "exclusion");
            if (!regex) {
              break;
            }
            for (const seed of seeds) {
              seed.addExclusion(regex);
            }
            // can happen async w/o slowing down crawling
            // each page is still checked if in scope before crawling, even while
            // queue is being filtered
            this.filterQueue(regex).catch((e) =>
              logger.warn("filtering queue error", e, "exclusion"),
            );
            break;

          case "removeExclusion":
            logger.debug("Remove Exclusion", { type, regex }, "exclusion");
            if (!regex) {
              break;
            }
            for (const seed of seeds) {
              seed.removeExclusion(regex);
            }
            break;
        }
      } catch (e) {
        logger.warn("Error processing message", e, "redis");
      }
    }
  }

  isStrMatch(s: string) {
    // if matches original string, then consider not a regex
    return s.replace(/\\/g, "").replace(/[\\^$*+?.()|[\]{}]/g, "\\$&") === s;
  }

  filterQueue(regexStr: string) {
    const regex = new RegExp(regexStr);

    let matcher = undefined;

    // regexStr just a string, optimize by using glob matching
    if (this.isStrMatch(regexStr)) {
      matcher = { match: `*${regexStr}*` };
    }

    const stream = this.redis.zscanStream(this.qkey, matcher);

    stream.on("data", async (results) => {
      stream.pause();

      for (const result of results) {
        const { url } = JSON.parse(result);
        if (regex.test(url)) {
          const removed = await this.redis.zrem(this.qkey, result);
          //if (removed) {
          await this.markExcluded(url);
          //}
          logger.debug(
            "Removing excluded URL",
            { url, regex, removed },
            "exclusion",
          );
        }
      }

      stream.resume();
    });

    return new Promise<void>((resolve) => {
      stream.on("end", () => {
        resolve();
      });
    });
  }

  async incFailCount() {
    const key = `${this.crawlId}:status:failcount:${this.uid}`;
    const res = await this.redis.incr(key);

    // consider failed if 3 failed retries in 60 secs
    await this.redis.expire(key, 60);
    return res >= 3;
  }

  async addToQueue(
    {
      url,
      seedId,
      depth = 0,
      extraHops = 0,
      ts = 0,
      pageid = undefined,
    }: QueueEntry,
    limit = 0,
  ) {
    url = normalizeUrl(url, normalizeUrlOpts);
    const added = this._timestamp();
    const data: QueueEntry = { added, url, seedId, depth, extraHops };

    if (ts) {
      data.ts = ts;
    }
    if (pageid) {
      data.pageid = pageid;
    }

    // return codes
    // 0 - url queued successfully
    // 1 - url queue size limit reached
    // 2 - url is a dupe
    return await this.redis.addqueue(
      this.pkey,
      this.qkey,
      this.skey,
      this.esKey,
      this.exKey,
      url,
      this._getScore(data),
      JSON.stringify(data),
      limit,
    );
  }

  async nextFromQueue() {
    const json = await this._getNext();

    if (!json) {
      return null;
    }

    let data;

    try {
      data = JSON.parse(json);
    } catch (e) {
      logger.error("Invalid queued json", json, "state");
      return null;
    }

    await this.markStarted(data.url);

    return new PageState(data);
  }

  async has(url: string) {
    return !!(await this.redis.sismember(this.skey, url));
  }

  async serialize(): Promise<SaveState> {
    //const queued = await this._iterSortKey(this.qkey);
    // const done = await this.numDone();
    const seen = await this._iterSet(this.skey);
    const queued = await this._iterSortedKey(this.qkey, seen);
    const pending = await this.getPendingList();
    const failed = await this._iterListKeys(this.fkey, seen);
    const errors = await this.getErrorList();
    const extraSeeds = await this._iterListKeys(this.esKey, seen);
    const sitemapDone = await this.isSitemapDone();
    const excludedSet = await this._iterSet(this.exKey);

    const finished = [...seen.values()];
    const excluded = [...excludedSet.values()];

    return {
      extraSeeds,
      finished,
      queued,
      pending,
      sitemapDone,
      failed,
      errors,
      excluded,
    };
  }

  _getScore(data: QueueEntry) {
    return (
      (data.depth || 0) +
      (data.extraHops || 0) * MAX_DEPTH +
      (data.retry || 0) * MAX_DEPTH * 2
    );
  }

  async _iterSet(key: string, count = 100) {
    const stream = this.redis.sscanStream(key, { count });

    const results: Set<string> = new Set<string>();

    stream.on("data", async (someResults: string[]) => {
      stream.pause();

      for (const result of someResults) {
        results.add(result);
      }

      stream.resume();
    });

    await new Promise<void>((resolve) => {
      stream.on("end", () => {
        resolve();
      });
    });

    return results;
  }

  async _iterSortedKey(key: string, seenSet: Set<string>, inc = 100) {
    const results: string[] = [];

    const len = await this.redis.zcard(key);

    for (let i = 0; i < len; i += inc) {
      const someResults = await this.redis.zrangebyscore(
        key,
        0,
        "inf",
        "LIMIT",
        i,
        inc,
      );

      for (const result of someResults) {
        const json = JSON.parse(result);
        seenSet.delete(json.url);
        results.push(result);
      }
    }

    return results;
  }

  async _iterListKeys(key: string, seenSet: Set<string>, inc = 100) {
    const results: string[] = [];

    const len = await this.redis.llen(key);

    for (let i = 0; i < len; i += inc) {
      const someResults = await this.redis.lrange(key, i, i + inc - 1);

      for (const result of someResults) {
        const json = JSON.parse(result);
        //for extra seeds
        seenSet.delete(json.url || json.newUrl);
        results.push(result);
      }
    }
    return results;
  }

  async load(state: SaveState, seeds: ScopedSeed[], checkScope: boolean) {
    // need to delete existing keys, if exist to fully reset state
    await this.redis.del(this.qkey);
    await this.redis.del(this.pkey);
    await this.redis.del(this.dkey);
    await this.redis.del(this.fkey);
    await this.redis.del(this.skey);
    await this.redis.del(this.ekey);
    await this.redis.del(this.exKey);

    let seen: string[] = [];

    if (state.finished) {
      seen = state.finished;

      await this.redis.set(this.dkey, state.finished.length);
    }

    if (state.extraSeeds) {
      const origLen = seeds.length;

      for (const extraSeed of state.extraSeeds) {
        const { newUrl, origSeedId }: ExtraRedirectSeed = JSON.parse(extraSeed);
        await this.addExtraSeed(seeds, origLen, origSeedId, newUrl);
      }
    }

    for (const json of state.queued) {
      const data = JSON.parse(json);
      if (checkScope) {
        if (!this.recheckScope(data, seeds)) {
          continue;
        }
      }

      await this.redis.zadd(this.qkey, this._getScore(data), json);
      seen.push(data.url);
    }

    for (let json of state.pending) {
      let data;

      // if the data is string, parse
      if (typeof json === "string") {
        data = JSON.parse(json);
        // otherwise, use as is, set json to json version
      } else if (typeof json === "object") {
        data = json;
        json = JSON.stringify(data);
      } else {
        continue;
      }

      if (checkScope) {
        if (!this.recheckScope(data, seeds)) {
          continue;
        }
      }

      await this.redis.zadd(this.qkey, this._getScore(data), json);
      seen.push(data.url);

      if (state.sitemapDone) {
        await this.markSitemapDone();
      }
    }

    // backwards compatibility: not using done, instead 'finished'
    // contains list of finished URLs
    if (state.done) {
      if (typeof state.done === "number") {
        // done key is just an int counter
        await this.redis.set(this.dkey, state.done);
      } else if (state.done instanceof Array) {
        // for backwards compatibility with old save states
        for (const json of state.done) {
          const data = JSON.parse(json);
          if (data.failed) {
            await this.redis.zadd(this.qkey, this._getScore(data), json);
          } else {
            await this.redis.incr(this.dkey);
          }
          seen.push(data.url);
        }
      }
    }

    for (const json of state.failed) {
      const data = JSON.parse(json);
      const retry = data.retry || 0;
      // allow retrying failed URLs if number of retries has increased
      if (retry < this.maxRetries) {
        await this.redis.zadd(this.qkey, this._getScore(data), json);
      } else {
        await this.redis.rpush(this.fkey, json);
      }
      seen.push(data.url);
    }

    for (const json of state.errors) {
      await this.logError(json);
    }

    await this.redis.sadd(this.skey, seen);

    if (state.excluded?.length) {
      await this.redis.sadd(this.exKey, state.excluded);
    }

    return seen.length;
  }

  async numDone() {
    const done = await this.redis.get(this.dkey);
    return parseInt(done || "0");
  }

  async numPending() {
    const res = await this.redis.hlen(this.pkey);

    // reset pendings
    if (res > 0 && !(await this.queueSize())) {
      await this.resetPendings();
    }

    return res;
  }

  async numFailed() {
    return await this.redis.llen(this.fkey);
  }

  async getPendingList() {
    return await this.redis.hvals(this.pkey);
  }

  async getErrorList() {
    return await this.redis.lrange(this.ekey, 0, -1);
  }

  async clearOwnPendingLocks() {
    try {
      const pendingUrls = await this.redis.hkeys(this.pkey);

      for (const url of pendingUrls) {
        await this.redis.unlockpending(this.pkey + ":" + url, this.uid);
      }
    } catch (e) {
      logger.error("Redis Del Pending Failed", e, "state");
    }
  }

  async resetPendings() {
    const pendingUrls = await this.redis.hkeys(this.pkey);

    for (const url of pendingUrls) {
      const res = await this.redis.requeue(
        this.pkey,
        this.qkey,
        this.pkey + ":" + url,
        url,
        this.maxRetries,
        MAX_DEPTH,
      );
      switch (res) {
        case 1:
          logger.info(`Requeued: ${url}`, {}, "state");
          break;

        case 2:
          logger.info(`Not requeuing anymore: ${url}`, {}, "state");
          break;
      }
    }
  }

  async queueSize() {
    return await this.redis.zcard(this.qkey);
  }

  async addIfNoDupe(key: string, url: string, status: number) {
    url = normalizeUrl(url, normalizeUrlOpts);
    return (
      (await this.redis.sadd(
        key,
        normalizeDedupeStatus(status) + "|" + url,
      )) === 1
    );
  }

  async removeDupe(key: string, url: string, status: number) {
    return await this.redis.srem(
      key,
      normalizeDedupeStatus(status) + "|" + url,
    );
  }

  async isInUserSet(value: string) {
    return (await this.redis.sismember(this.crawlId + ":user", value)) === 1;
  }

  async addToUserSet(value: string) {
    return (await this.redis.sadd(this.crawlId + ":user", value)) === 1;
  }

  async logError(error: string) {
    return await this.redis.lpush(this.ekey, error);
  }

  async logBehavior(behaviorLog: string) {
    return await this.redis.lpush(this.bkey, behaviorLog);
  }

  async _updateRobotsAccessTime(robotsUrl: string) {
    const accessTime = Date.now();
    await this.redis.zadd(this.lkey, accessTime, robotsUrl);
  }

  async setCachedRobots(robotsUrl: string, body: string) {
    await this._updateRobotsAccessTime(robotsUrl);
    await this.redis.set(`${this.rkey}:${robotsUrl}`, body);

    // prune least-recently used items in zset and robots cache if over limit
    const cacheCount = await this.redis.zcard(this.lkey);
    if (cacheCount > ROBOTS_CACHE_LIMIT) {
      const diff = cacheCount - ROBOTS_CACHE_LIMIT;
      const keysToDelete = await this.redis.zrange(this.lkey, 0, diff - 1);

      for (const keyToDelete of keysToDelete) {
        logger.debug(
          "Deleting cached robots.txt, over cache limit",
          { url: keyToDelete },
          "robots",
        );
        await this.redis.del(`${this.rkey}:${keyToDelete}`);
        await this.redis.zrem(this.lkey, keyToDelete);
      }
    }
  }

  async getCachedRobots(robotsUrl: string) {
    await this._updateRobotsAccessTime(robotsUrl);
    return await this.redis.get(`${this.rkey}:${robotsUrl}`);
  }

  async writeToPagesQueue(
    data: Record<string, string | number | boolean | object>,
  ) {
    data["filename"] = await this.getWACZFilename();
    return await this.redis.lpush(this.pageskey, JSON.stringify(data));
  }

  // add extra seeds from redirect
  async addExtraSeed(
    seeds: ScopedSeed[],
    origLength: number,
    origSeedId: number,
    newUrl: string,
  ) {
    if (!seeds[origSeedId]) {
      logger.fatal(
        "State load, original seed missing",
        { origSeedId },
        "state",
      );
    }
    const redirectSeed: ExtraRedirectSeed = { origSeedId, newUrl };
    const seedData = JSON.stringify(redirectSeed);
    const newSeedId =
      origLength +
      (await this.redis.addnewseed(
        this.esKey,
        this.esMap,
        this.skey,
        seedData,
        newUrl,
      ));
    seeds[newSeedId] = seeds[origSeedId].newScopedSeed(newUrl);

    //const newSeedId = seeds.length - 1;
    //await this.redis.sadd(this.skey, newUrl);
    //await this.redis.lpush(this.esKey, JSON.stringify(redirectSeed));
    return newSeedId;
  }

  async getSeedAt(seeds: ScopedSeed[], origLength: number, newSeedId: number) {
    if (seeds[newSeedId]) {
      return seeds[newSeedId];
    }

    const newSeedDataList = await this.redis.lrange(
      this.esKey,
      newSeedId - origLength,
      newSeedId - origLength,
    );
    if (newSeedDataList.length) {
      const { origSeedId, newUrl } = JSON.parse(
        newSeedDataList[0],
      ) as ExtraRedirectSeed;
      seeds[newSeedId] = seeds[origSeedId].newScopedSeed(newUrl);
    }

    return seeds[newSeedId];
  }

  async getExtraSeeds() {
    const seeds: ExtraRedirectSeed[] = [];
    const res = await this.redis.lrange(this.esKey, 0, -1);
    for (const key of res) {
      seeds.push(JSON.parse(key));
    }
    return seeds;
  }

  async isSitemapDone() {
    return (await this.redis.get(this.sitemapDoneKey)) == "1";
  }

  async markSitemapDone() {
    await this.redis.set(this.sitemapDoneKey, "1");
  }

  async markProfileUploaded(result: UploadResult & { modified?: string }) {
    result.modified = this._timestamp();
    await this.redis.set(
      `${this.crawlId}:profileUploaded`,
      JSON.stringify(result),
    );
  }

  // DEPENDENT CRAWLS FOR DEDUPE (requires WACZ)
  async addDupeCrawlDependency(crawlId: string, index: string) {
    if (crawlId !== this.crawlId) {
      await this.redis.sadd(`${this.uid}:duperef`, crawlId + " " + index);
      await this.redis.sadd(`${this.crawlId}:reqCrawls`, crawlId);
    }
  }

  // Requires crawling with WACZ to match dependencies
  async getDupeDependentCrawls() {
    const dependRefs = await this.redis.smembers(`${this.uid}:duperef`);
    const crawlIds = [];
    for (const value of dependRefs) {
      const [crawlId, index] = value.split(" ");
      if (crawlId && crawlId !== this.crawlId) {
        const source = await this.dedupeRedis.lindex(
          `c:${crawlId}:wacz`,
          Number(index),
        );
        if (source) {
          const entry = JSON.parse(source);
          entry.crawlId = crawlId;
          crawlIds.push(entry);
        }
      }
    }
    return crawlIds;
  }
}
