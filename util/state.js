const Job = require("puppeteer-cluster/dist/Job").default;


// ============================================================================
class BaseState
{
  constructor() {
    this.draining = false;
  }

  setDrain() {
    this.draining = true;
  }
}


// ============================================================================
class MemoryCrawlState extends BaseState
{
  constructor() {
    super();
    this.seenList = new Set();
    this.queue = [];
    this.pending = {};
    this.done = [];
  }

  push(job) {
    this.queue.unshift(job.data);
  }

  size() {
    return this.draining ? 0 : this.queue.length;
  }

  shift() {
    const data = this.queue.pop();
    data.started = new Date().toISOString();
    const str = JSON.stringify(data);
    this.pending[str] = 1;

    const callback = {
      resolve: () => {
        delete this.pending[str];
        data.finished = new Date().toISOString();
        this.done.unshift(data);
      },

      reject: () => {
        console.warn("URL Load Failed: " + data.url);
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
    const pending = Object.keys(this.pending);
    const done = this.done.map(x => JSON.stringify(x));

    return {queued, pending, done};
  }

  async load(state) {
    for (const json of state.queued) {
      const data = JSON.parse(json);
      this.queue.push(data);
      this.seenList.add(data.url);
    }

    for (const json of state.pending) {
      const data = JSON.parse(json);
      this.queue.push(data);
      this.seenList.add(data.url);
    }

    for (const json of state.done) {
      const data = JSON.parse(json);
      this.done.push(data);
      this.seenList.add(data.url);
    }

    return this.seenList.size;
  }

}


// ============================================================================
class RedisCrawlState extends BaseState
{
  constructor(redis, key) {
    super();
    this.redis = redis;

    this.key = key;

    this.qkey = this.key + ":q";
    this.pkey = this.key + ":p";
    this.skey = this.key + ":s";
    this.dkey = this.key + ":d";
  }

  async push(job) {
    await this.redis.lpush(this.qkey, JSON.stringify(job.data));
  }

  async size() {
    // return 0 if draining to avoid pulling any more data
    if (this.draining) {
      return 0;
    }

    return await this.redis.llen(this.qkey);
  }

  async shift() {
    //const json = await this.redis.rpoplpush(this.qkey, this.pkey);
    let json = await this.redis.rpop(this.qkey);
    const data = JSON.parse(json);
    const started = new Date().toISOString();
    data.started = started;
    json = JSON.stringify(data);
    await this.redis.sadd(this.pkey, json);

    const callback = {
      resolve: async () => {
        //await this.redis.lrem(this.pkey, 1, json);
        await this.redis.srem(this.pkey, json);

        //data.started = started;
        data.finished = new Date().toISOString();
        await this.redis.lpush(this.dkey, JSON.stringify(data));
      },

      reject: () => {
        console.warn("URL Load Failed: " + data.url);
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

  async load(state) {
    const seen = [];
    const addToSeen = (json) => seen.push(JSON.parse(json).url);

    for (const json of state.queued) {
      await this.redis.rpush(this.qkey, json);
      addToSeen(json);
    }

    for (const json of state.pending) {
      await this.redis.rpush(this.qkey, json);
      addToSeen(json);
    }

    for (const json of state.done) {
      await this.redis.rpush(this.dkey, json);
      addToSeen(json);
    }

    await this.redis.sadd(this.skey, seen);
    return seen.length;
  }
}

//module.exports.RedisCrawlState = MemoryCrawlState;
module.exports.RedisCrawlState = RedisCrawlState;
module.exports.MemoryCrawlState = MemoryCrawlState;
