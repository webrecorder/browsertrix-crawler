import { logger } from "./logger.js";

import { MAX_DEPTH } from "./constants.js";


// ============================================================================
export const LoadState = {
  FAILED: 0,
  CONTENT_LOADED: 1,
  FULL_PAGE_LOADED: 2,
  EXTRACTION_DONE: 3,
  BEHAVIORS_DONE: 4,
};

// ============================================================================
export class PageState
{
  constructor(redisData) {
    this.url = redisData.url;
    this.seedId = redisData.seedId;
    this.depth = redisData.depth;
    this.extraHops = redisData.extraHops;

    this.workerid = null;
    this.pageid = null;
    this.title = null;

    this.isHTMLPage = null;
    this.text = null;

    this.skipBehaviors = false;
    this.filteredFrames = [];

    this.loadState = LoadState.FAILED;
    this.logDetails = {};
  }
}


// ============================================================================
export class RedisCrawlState
{
  constructor(redis, key, maxPageTime, uid) {
    this.redis = redis;

    this.maxRetryPending = 1;

    this._lastSize = 0;

    this.uid = uid;
    this.key = key;
    this.maxPageTime = maxPageTime;

    this.qkey = this.key + ":q";
    this.pkey = this.key + ":p";
    this.skey = this.key + ":s";
    this.dkey = this.key + ":d";

    this._initLuaCommands(this.redis);
  }

  _initLuaCommands(redis) {
    redis.defineCommand("addqueue", {
      numberOfKeys: 3,
      lua: `
redis.call('sadd', KEYS[3], ARGV[1]);
redis.call('zadd', KEYS[2], ARGV[2], ARGV[3]);
redis.call('hdel', KEYS[1], ARGV[1]);
`
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
`
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
  redis.call('setex', KEYS[2], ARGV[3], "1");
end

`
    });

    redis.defineCommand("movedone", {
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

`
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
`
    });

  }

  async _getNext() {
    return await this.redis.getnext(this.qkey, this.pkey);
  }

  _timestamp() {
    return new Date().toISOString();
  }

  async markStarted(url) {
    const started = this._timestamp();

    return await this.redis.markstarted(this.pkey, this.pkey + ":" + url, url, started, this.maxPageTime);
  }

  async markFinished(url) {
    const finished = this._timestamp();

    return await this.redis.movedone(this.pkey, this.dkey, url, finished, "finished");
  }

  async markFailed(url) {
    return await this.redis.movedone(this.pkey, this.dkey, url, "1", "failed");
  }

  recheckScope(data, seeds) {
    const seed = seeds[data.seedId];

    return seed.isIncluded(data.url, data.depth, data.extraHops);
  }

  async isFinished() {
    return (await this.queueSize() == 0) && (await this.numDone() > 0);
  }

  async setStatus(status_) {
    await this.redis.hset(`${this.key}:status`, this.uid, status_);
  }

  async getStatus() {
    return await this.redis.hget(`${this.key}:status`, this.uid);
  }

  async incFailCount() {
    const key = `${this.key}:status:failcount:${this.uid}`;
    const res = await this.redis.incr(key);

    // consider failed if 3 failed retries in 60 secs
    await this.redis.expire(key, 60);
    return (res >= 3);
  }

  async addToQueue({url, seedId, depth = 0, extraHops = 0} = {}) {
    const added = this._timestamp();
    const data = {added, url, seedId, depth};
    if (extraHops) {
      data.extraHops = extraHops;
    }

    await this.redis.addqueue(this.pkey, this.qkey, this.skey, url, this._getScore(data), JSON.stringify(data));
  }

  async nextFromQueue() {
    const json = await this._getNext();
    let data;

    try {
      data = JSON.parse(json);
    } catch(e) {
      logger.error("Invalid queued json", json);
      return null;
    }

    if (!data) {
      return null;
    }

    await this.markStarted(data.url);

    return new PageState(data);
  }

  async has(url) {
    return !!await this.redis.sismember(this.skey, url);
  }

  async serialize() {
    //const queued = await this._iterSortKey(this.qkey);
    const queued = await this._iterSortedKey(this.qkey);
    const done = await this._iterListKeys(this.dkey);
    const pending = await this.getPendingList();

    return {queued, pending, done};
  }

  _getScore(data) {
    return (data.depth || 0) + (data.extraHops || 0) * MAX_DEPTH;
  }

  async _iterSortedKey(key, inc = 100) {
    const results = [];

    const len = await this.redis.zcard(key);

    for (let i = 0; i < len; i += inc) {
      const someResults = await this.redis.zrangebyscore(key, 0, "inf", "limit", i, inc);
      results.push(...someResults);
    }

    return results;
  }

  async _iterListKeys(key, inc = 100) {
    const results = [];

    const len = await this.redis.llen(key);

    for (let i = 0; i < len; i += inc) {
      const someResults = await this.redis.lrange(key, i, i + inc - 1);
      results.push(...someResults);
    }
    return results;
  }

  async load(state, seeds, checkScope) {
    const seen = [];

    // need to delete existing keys, if exist to fully reset state
    await this.redis.del(this.qkey);
    await this.redis.del(this.pkey);
    await this.redis.del(this.dkey);
    await this.redis.del(this.skey);

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

    for (const json of state.done) {
      const data = JSON.parse(json);
      if (data.failed) {
        await this.redis.zadd(this.qkey, this._getScore(data), json);
      } else {
        await this.redis.rpush(this.dkey, json);
      }
      seen.push(data.url);
    }

    await this.redis.sadd(this.skey, seen);
    return seen.length;
  }

  async numDone() {
    return await this.redis.llen(this.dkey);
  }

  async numSeen() {
    return await this.redis.scard(this.skey);
  }

  async numPending() {
    const res = await this.redis.hlen(this.pkey);

    // reset pendings
    if (res > 0 && !this._lastSize) {
      await this.resetPendings();
    }

    return res;
  }

  async getPendingList() {
    const list = await this.redis.hvals(this.pkey);
    return list.map(x => JSON.parse(x));
  }

  async resetPendings() {
    const pendingUrls = await this.redis.hkeys(this.pkey);

    for (const url of pendingUrls) {
      const res = await this.redis.requeue(this.pkey, this.qkey, this.pkey + ":" + url, url, this.maxRetryPending);
      switch (res) {
      case 1:
        logger.info(`Requeued: ${url}`);
        break;

      case 2:
        logger.info(`Not requeuing anymore: ${url}`);
        break;
      }
    }
  }

  async queueSize() {
    this._lastSize = await this.redis.zcard(this.qkey);
    return this._lastSize;
  }

  async addIfNoDupe(key, value) {
    return await this.redis.sadd(key, value) === 1;
  }

  async removeDupe(key, value) {
    return await this.redis.srem(key, value);
  }
}

