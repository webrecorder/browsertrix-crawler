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
    this.pending = new Set();
    this.done = [];
  }

  push(job) {
    this.queue.unshift(job.data);
  }

  realSize() {
    return this.queue.length;
  }

  shift() {
    const data = this.queue.pop();
    data.started = new Date().toISOString();
    const str = JSON.stringify(data);
    this.pending.add(str);

    const callback = {
      resolve: () => {
        this.pending.delete(str);
        data.finished = new Date().toISOString();
        this.done.unshift(data);
      },

      reject: (e) => {
        this.pending.delete(str);
        console.warn(`URL Load Failed: ${data.url}, Reason: ${e}`);
        data.failed = true;
        this.done.unshift(data);
      }
    };

    return new Job(data, undefined, callback);
  }

  has(url) {
    return this.seenList.has(url);
  }

  add(url) {
    return this.seenList.add(url);
  }

  async serialize() {
    const queued = this.queue.map(x => JSON.stringify(x));
    const pending = Array.from(this.pending.values());
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

    this.key = key;
    this.pageTimeout = pageTimeout / 1000;

    this.qkey = this.key + ":q";
    this.pkey = this.key + ":p";
    this.skey = this.key + ":s";
    this.dkey = this.key + ":d";


    redis.defineCommand("movestarted", {
      numberOfKeys: 2,
      lua: "local val = redis.call('rpop', KEYS[1]); if (val) then local json = cjson.decode(val); json['started'] = ARGV[1]; val = cjson.encode(json); redis.call('sadd', KEYS[2], val); redis.call('expire', KEYS[2], ARGV[2]); end; return val"
    });

    redis.defineCommand("movefinished", {
      numberOfKeys: 2,
      lua: "local val = ARGV[1]; if (redis.call('srem', KEYS[1], val)) then local json = cjson.decode(val); json[ARGV[3]] = ARGV[2]; val = cjson.encode(json); redis.call('lpush', KEYS[2], val); end; return val"
    });

  }

  async push(job) {
    await this.redis.lpush(this.qkey, JSON.stringify(job.data));
  }

  async realSize() {
    return await this.redis.llen(this.qkey);
  }

  async shift() {
    const started = new Date().toISOString();
    // atomically move from queue list -> pending set while adding started timestamp
    // set pending set expire to page timeout
    const json = await this.redis.movestarted(this.qkey, this.pkey, started, this.pageTimeout);
    const data = JSON.parse(json);

    const callback = {
      resolve: async () => {
        const finished = new Date().toISOString();
        // atomically move from pending set -> done list while adding finished timestamp
        await this.redis.movefinished(this.pkey, this.dkey, json, finished, "finished");
      },

      reject: async (e) => {
        console.warn(`URL Load Failed: ${data.url}, Reason: ${e}`);
        await this.redis.movefinished(this.pkey, this.dkey, json, true, "failed");
      }
    };

    return new Job(data, undefined, callback);
  }

  async has(url) {
    return !!await this.redis.sismember(this.skey, url);
  }

  async add(url) {
    return await this.redis.sadd(this.skey, url);
  }

  async serialize() {
    const queued = await this.redis.lrange(this.qkey, 0, -1);
    const pending = await this.redis.smembers(this.pkey);
    const done = await this.redis.lrange(this.dkey, 0, -1);

    return {queued, pending, done};
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
    return await this.redis.scard(this.pkey);
  }
}

module.exports.RedisCrawlState = RedisCrawlState;
module.exports.MemoryCrawlState = MemoryCrawlState;
