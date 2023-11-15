import { Redis, Result, Callback } from "ioredis";

import { logger } from "./logger.js";

import { MAX_DEPTH } from "./constants.js";
import { ScopedSeed } from "./seeds.js";
import { Frame } from "puppeteer-core";

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
export type WorkerId = number;

// ============================================================================
export type QueueEntry = {
  added?: string;
  url: string;
  seedId: number;
  depth: number;
  extraHops: number;
};

// ============================================================================
export type PageCallbacks = {
  addLink?: (url: string) => void;
};

// ============================================================================
export class PageState {
  url: string;
  seedId: number;
  depth: number;
  extraHops: number;

  workerid!: WorkerId;

  pageid?: string;
  title?: string;
  mime?: string;

  callbacks: PageCallbacks = {};

  isHTMLPage?: boolean;
  text?: string;
  favicon?: string;

  skipBehaviors = false;
  filteredFrames: Frame[] = [];
  loadState: LoadState = LoadState.FAILED;

  logDetails = {};

  constructor(redisData: QueueEntry) {
    this.url = redisData.url;
    this.seedId = redisData.seedId;
    this.depth = redisData.depth;
    this.extraHops = redisData.extraHops || 0;
  }
}

// ============================================================================
declare module "ioredis" {
  interface RedisCommander<Context> {
    addqueue(
      pkey: string,
      qkey: string,
      skey: string,
      url: string,
      score: number,
      data: string,
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

    movefailed(
      pkey: string,
      fkey: string,
      url: string,
      value: string,
      state: string,
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
      maxRetryPending: number,
    ): Result<number, Context>;
  }
}

// ============================================================================
export class RedisCrawlState {
  redis: Redis;
  maxRetryPending = 1;

  uid: string;
  key: string;
  maxPageTime: number;

  qkey: string;
  pkey: string;
  skey: string;
  dkey: string;
  fkey: string;
  ekey: string;

  constructor(redis: Redis, key: string, maxPageTime: number, uid: string) {
    this.redis = redis;

    this.uid = uid;
    this.key = key;
    this.maxPageTime = maxPageTime;

    this.qkey = this.key + ":q";
    this.pkey = this.key + ":p";
    this.skey = this.key + ":s";
    // done (integer)
    this.dkey = this.key + ":d";
    // failed
    this.fkey = this.key + ":f";
    // crawler errors
    this.ekey = this.key + ":e";

    this._initLuaCommands(this.redis);
  }

  _initLuaCommands(redis: Redis) {
    redis.defineCommand("addqueue", {
      numberOfKeys: 3,
      lua: `
local size = redis.call('scard', KEYS[3]);
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

    redis.defineCommand("movefailed", {
      numberOfKeys: 2,
      lua: `
local json = redis.call('hget', KEYS[1], ARGV[1]);

if json then
  local data = cjson.decode(json);
  data[ARGV[3]] = ARGV[2];
  json = cjson.encode(data);

  redis.call('lpush', KEYS[2], json);
  redis.call('hdel', KEYS[1], ARGV[1]);
end

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
    data['retry'] = (data['retry'] or 0) + 1;
    redis.call('hdel', KEYS[1], ARGV[1]);
    if tonumber(data['retry']) <= tonumber(ARGV[2]) then
      json = cjson.encode(data);
      redis.call('zadd', KEYS[2], 0, json);
      return 1;
    else
      return 2;
    end
  end
end
return 0;
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

  async markFailed(url: string) {
    await this.redis.movefailed(this.pkey, this.fkey, url, "1", "failed");

    return await this.redis.incr(this.dkey);
  }

  async markExcluded(url: string) {
    await this.redis.hdel(this.pkey, url);

    await this.redis.srem(this.skey, url);
  }

  recheckScope(data: QueueEntry, seeds: ScopedSeed[]) {
    const seed = seeds[data.seedId];

    return seed.isIncluded(data.url, data.depth, data.extraHops);
  }

  async isFinished() {
    return (await this.queueSize()) == 0 && (await this.numDone()) > 0;
  }

  async setStatus(status_: string) {
    await this.redis.hset(`${this.key}:status`, this.uid, status_);
  }

  async getStatus(): Promise<string> {
    return (await this.redis.hget(`${this.key}:status`, this.uid)) || "";
  }

  async setArchiveSize(size: number) {
    return await this.redis.hset(`${this.key}:size`, this.uid, size);
  }

  async isCrawlStopped() {
    if ((await this.redis.get(`${this.key}:stopping`)) === "1") {
      return true;
    }

    if ((await this.redis.hget(`${this.key}:stopone`, this.uid)) === "1") {
      return true;
    }

    return false;
  }

  async isCrawlCanceled() {
    return (await this.redis.get(`${this.key}:canceled`)) === "1";
  }

  // note: not currently called in crawler, but could be
  // crawl may be stopped by setting this elsewhere in shared redis
  async stopCrawl() {
    await this.redis.set(`${this.key}:stopping`, "1");
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
            this.filterQueue(regex);
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
    const key = `${this.key}:status:failcount:${this.uid}`;
    const res = await this.redis.incr(key);

    // consider failed if 3 failed retries in 60 secs
    await this.redis.expire(key, 60);
    return res >= 3;
  }

  //async addToQueue({url : string, seedId, depth = 0, extraHops = 0} = {}, limit = 0) {
  async addToQueue(
    { url, seedId, depth = 0, extraHops = 0 }: QueueEntry,
    limit = 0,
  ) {
    const added = this._timestamp();
    const data: QueueEntry = { added, url, seedId, depth, extraHops };

    // return codes
    // 0 - url queued successfully
    // 1 - url queue size limit reached
    // 2 - url is a dupe
    return await this.redis.addqueue(
      this.pkey,
      this.qkey,
      this.skey,
      url,
      this._getScore(data),
      JSON.stringify(data),
      limit,
    );
  }

  async nextFromQueue() {
    const json = await this._getNext();
    let data;

    try {
      data = JSON.parse(json);
    } catch (e) {
      logger.error("Invalid queued json", json, "redis");
      return null;
    }

    if (!data) {
      return null;
    }

    await this.markStarted(data.url);

    return new PageState(data);
  }

  async has(url: string) {
    return !!(await this.redis.sismember(this.skey, url));
  }

  async serialize() {
    //const queued = await this._iterSortKey(this.qkey);
    const done = await this.numDone();
    const queued = await this._iterSortedKey(this.qkey);
    const pending = await this.getPendingList();
    const failed = await this._iterListKeys(this.fkey);
    const errors = await this.getErrorList();

    return { done, queued, pending, failed, errors };
  }

  _getScore(data: QueueEntry) {
    return (data.depth || 0) + (data.extraHops || 0) * MAX_DEPTH;
  }

  async _iterSortedKey(key: string, inc = 100) {
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
      results.push(...someResults);
    }

    return results;
  }

  async _iterListKeys(key: string, inc = 100) {
    const results: string[] = [];

    const len = await this.redis.llen(key);

    for (let i = 0; i < len; i += inc) {
      const someResults = await this.redis.lrange(key, i, i + inc - 1);
      results.push(...someResults);
    }
    return results;
  }

  async load(
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: Record<string, any>,
    seeds: ScopedSeed[],
    checkScope: boolean,
  ) {
    const seen: string[] = [];

    // need to delete existing keys, if exist to fully reset state
    await this.redis.del(this.qkey);
    await this.redis.del(this.pkey);
    await this.redis.del(this.dkey);
    await this.redis.del(this.fkey);
    await this.redis.del(this.skey);
    await this.redis.del(this.ekey);

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

    for (const json of state.pending) {
      const data = JSON.parse(json);
      if (checkScope) {
        if (!this.recheckScope(data, seeds)) {
          continue;
        }
      }

      await this.redis.zadd(this.qkey, this._getScore(data), json);
      seen.push(data.url);
    }

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

    for (const json of state.failed) {
      const data = JSON.parse(json);
      await this.redis.zadd(this.qkey, this._getScore(data), json);
      seen.push(data.url);
    }

    for (const json of state.errors) {
      await this.logError(json);
    }

    await this.redis.sadd(this.skey, seen);
    return seen.length;
  }

  async numDone() {
    const done = await this.redis.get(this.dkey);
    return parseInt(done || "0");
  }

  async numSeen() {
    return await this.redis.scard(this.skey);
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
    const list = await this.redis.hvals(this.pkey);
    return list.map((x) => JSON.parse(x));
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
        this.maxRetryPending,
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

  async addIfNoDupe(key: string, value: string) {
    return (await this.redis.sadd(key, value)) === 1;
  }

  async removeDupe(key: string, value: string) {
    return await this.redis.srem(key, value);
  }

  async logError(error: string) {
    return await this.redis.lpush(this.ekey, error);
  }
}
