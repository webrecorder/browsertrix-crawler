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
class MemTaskCallbacks
{
  constructor(data, state) {
    this.data = data;
    this.state = state;

    this.json = JSON.stringify(this.data);
    this.state.pending.add(this.json);
  }

  start() {
    this.state.pending.delete(this.json);

    this.data.started = new Date().toISOString();
    this.json = JSON.stringify(this.data);

    this.state.pending.add(this.json);
  }

  resolve() {
    this.state.pending.delete(this.json);

    this.data.finished = new Date().toISOString();

    this.state.done.unshift(this.data);
  }

  reject(e) {
    this.state.pending.delete(this.json);
    console.warn(`URL Load Failed: ${this.data.url}, Reason: ${e}`);
    this.data.failed = true;
    this.state.done.unshift(this.data);
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
    this.pending.delete(JSON.stringify(job.data));
    this.queue.unshift(job.data);
  }

  realSize() {
    return this.queue.length;
  }

  shift() {
    const data = this.queue.pop();

    const callback = new MemTaskCallbacks(data, this);

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
class RedisTaskCallbacks
{
  constructor(json, state) {
    this.state = state;
    this.json = json;
    this.data = JSON.parse(json);
  }

  async start() {
    console.log("Start");
    this.json = await this.state._markStarted(this.json);
    console.log("Started: " + this.json);
  }

  async resolve() {
    // atomically move from pending set -> done list while adding finished timestamp
    await this.state._finish(this.json);
  }

  async reject(e) {
    console.warn(`URL Load Failed: ${this.data.url}, Reason: ${e}`);
    await this.state._fail(this.json);
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

    redis.defineCommand("addqueue", {
      numberOfKeys: 2,
      lua: "redis.call('srem', KEYS[1], ARGV[1]); redis.call('lpush', KEYS[2], ARGV[1])"
    });


    redis.defineCommand("markpending", {
      numberOfKeys: 2,
      lua: "local json = redis.call('rpop', KEYS[1]); redis.call('sadd', KEYS[2], json); return json"
    });

    redis.defineCommand("markstarted", {
      numberOfKeys: 1,
      lua: "local json = ARGV[1]; if (redis.call('srem', KEYS[1], json)) then local data = cjson.decode(json); data['started'] = ARGV[2]; json = cjson.encode(data); redis.call('sadd', KEYS[1], json); end; return json"
    });

    redis.defineCommand("movefinished", {
      numberOfKeys: 2,
      lua: "local json = ARGV[1]; if (redis.call('srem', KEYS[1], json)) then local data = cjson.decode(json); data[ARGV[3]] = ARGV[2]; json = cjson.encode(data); redis.call('lpush', KEYS[2], json); end; return json"
    });

  }

  async _markPending() {
    return await this.redis.markpending(this.qkey, this.pkey);
  }

  async _markStarted(json) {
    const started = new Date().toISOString();

    return await this.redis.markstarted(this.pkey, json, started);
  }

  async _finish(json) {
    const finished = new Date().toISOString();

    return await this.redis.movefinished(this.pkey, this.dkey, json, finished, "finished");
  }

  async _fail(json) {
    return await this.redis.movefinished(this.pkey, this.dkey, json, true, "failed");
  }

  async push(job) {
    //await this.redis.lpush(this.qkey, JSON.stringify(job.data));
    await this.redis.addqueue(this.pkey, this.qkey, JSON.stringify(job.data));
  }

  async realSize() {
    return await this.redis.llen(this.qkey);
  }

  async shift() {
    const json = await this._markPending();

    const callback = new RedisTaskCallbacks(json, this);

    return new Job(callback.data, undefined, callback);
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
