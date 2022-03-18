const Job = require("puppeteer-cluster/dist/Job").default;


// ============================================================================
class BaseState
{
  constructor() {
    this.drainMax = 0;
  }

  async setDrain() {
    this.drainMax = (await this.numPending()) + (await this.numDone());
  }

  async size() {
    return this.drainMax ? 0 : await this.realSize();
  }

  async finished() {
    return await this.realSize() == 0;
  }

  async numSeen() {
    return this.drainMax ? this.drainMax : await this.numRealSeen();
  }

  recheckScope(data, seeds) {
    const seed = seeds[data.seedId];

    return seed.isIncluded(data.url, data.depth, data.extraHops);
  }
}


// ============================================================================
class MemoryCrawlState extends BaseState
{
  constructor() {
    super();
    this.seenList = new Set();
    this.queue = [];
    this.pending = new Map();
    this.done = [];
  }

  push(job) {
    this.pending.delete(job.data.url);
    this.queue.unshift(job.data);
  }

  realSize() {
    return this.queue.length;
  }

  shift() {
    const data = this.queue.pop();

    const url = data.url;

    const state = this;

    state.pending.set(url, data);

    const callbacks = {
      start() {
        data.started = new Date().toISOString();

        state.pending.set(url, data);
      },

      resolve() {
        state.pending.delete(url);

        data.finished = new Date().toISOString();

        state.done.unshift(data);
      },

      reject(e) {
        console.warn(`Page Load Failed: ${url}, Reason: ${e}`);

        state.pending.delete(url);

        data.failed = true;

        state.done.unshift(data);
      }
    };

    return new Job(data, undefined, callbacks);
  }

  has(url) {
    return this.seenList.has(url);
  }

  add(url) {
    return this.seenList.add(url);
  }

  async serialize() {
    const queued = this.queue.map(x => JSON.stringify(x));
    const pending = Array.from(this.pending.values()).map(x => JSON.stringify(x));
    const done = this.done.map(x => JSON.stringify(x));

    return {queued, pending, done};
  }

  async load(state, seeds, checkScope=false) {
    for (const json of state.queued) {
      const data = JSON.parse(json);
      if (checkScope && !this.recheckScope(data, seeds)) {
        continue;
      }
      this.queue.push(data);
      this.seenList.add(data.url);
    }

    for (const json of state.pending) {
      const data = JSON.parse(json);
      if (checkScope && !this.recheckScope(data, seeds)) {
        continue;
      }
      this.queue.push(data);
      this.seenList.add(data.url);
    }

    for (const json of state.done) {
      const data = JSON.parse(json);
      if (data.failed) {
        this.queue.push(data);
      } else {
        this.done.push(data);
      }
      this.seenList.add(data.url);
    }

    return this.seenList.size;
  }

  async numDone() {
    return this.done.length;
  }

  async numRealSeen() {
    return this.seenList.size;
  }

  async numPending() {
    return this.pending.size;
  }
}


// ============================================================================
class RedisCrawlState extends BaseState
{
  constructor(redis, key, pageTimeout) {
    super();
    this.redis = redis;

    this._lastSize = 0;

    this.key = key;
    this.pageTimeout = pageTimeout / 1000;

    this.qkey = this.key + ":q";
    this.pkey = this.key + ":p";
    this.skey = this.key + ":s";
    this.dkey = this.key + ":d";

    redis.defineCommand("addqueue", {
      numberOfKeys: 2,
      lua: `
redis.call('lpush', KEYS[2], ARGV[2]);
redis.call('hdel', KEYS[1], ARGV[1]);
`
    });

    redis.defineCommand("getnext", {
      numberOfKeys: 2,
      lua: `
local json = redis.call('rpop', KEYS[1]);

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
    redis.call('lpush', KEYS[2], json);
    redis.call('hdel', KEYS[1], ARGV[1]);
    return 1
  end
end
return 0;
`
    });

  }

  async _getNext() {
    return await this.redis.getnext(this.qkey, this.pkey);
  }

  async _markStarted(url) {
    const started = new Date().toISOString();

    return await this.redis.markstarted(this.pkey, this.pkey + ":" + url, url, started, this.pageTimeout);
  }

  async _finish(url) {
    const finished = new Date().toISOString();

    return await this.redis.movedone(this.pkey, this.dkey, url, finished, "finished");
  }

  async _fail(url) {
    return await this.redis.movedone(this.pkey, this.dkey, url, "1", "failed");
  }

  async push(job) {
    await this.redis.addqueue(this.pkey, this.qkey, job.data.url, JSON.stringify(job.data));
  }

  async shift() {
    const json = await this._getNext();
    let data;

    try {
      data = JSON.parse(json);
    } catch(e) {
      console.error("Invalid queued json: ", json);
      return;
    }

    const url = data.url;

    const state = this;

    const callbacks = {
      async start() {
        await state._markStarted(url);
      },

      async resolve() {
        await state._finish(url);
      },

      async reject(e) {
        console.warn(`Page Load Failed: ${url}, Reason: ${e}`);
        await state._fail(url);
      }
    };

    return new Job(data, undefined, callbacks);
  }

  async has(url) {
    return !!await this.redis.sismember(this.skey, url);
  }

  async add(url) {
    return await this.redis.sadd(this.skey, url);
  }

  async serialize() {
    const queued = await this._iterListKeys(this.qkey);
    const done = await this._iterListKeys(this.dkey);
    const pending = await this.redis.hvals(this.pkey);

    return {queued, pending, done};
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
 
      await this.redis.rpush(this.qkey, json);
      seen.push(data.url);
    }

    for (const json of state.pending) {
      const data = JSON.parse(json);
      if (checkScope) {
        if (!this.recheckScope(data, seeds)) {
          continue;
        }
      }

      await this.redis.rpush(this.qkey, json);
      seen.push(data.url);
    }

    for (const json of state.done) {
      const data = JSON.parse(json);
      if (data.failed) {
        await this.redis.rpush(this.qkey, json);
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

  async numRealSeen() {
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

  async resetPendings() {
    const pendingUrls = await this.redis.hkeys(this.pkey);

    for (const url of pendingUrls) {
      if (await this.redis.requeue(this.pkey, this.qkey, this.pkey + ":" + url, url)) {
        console.log("Requeued: " + url);
      }
    }
  }

  async realSize() {
    this._lastSize = await this.redis.llen(this.qkey);
    return this._lastSize;
  }
}

module.exports.RedisCrawlState = RedisCrawlState;
module.exports.MemoryCrawlState = MemoryCrawlState;
