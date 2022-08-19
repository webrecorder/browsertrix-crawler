const ws = require("ws");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const { initRedis } = require("./redis");

const indexHTML = fs.readFileSync(path.join(__dirname, "..", "html", "screencast.html"), {encoding: "utf8"});


// ===========================================================================
class WSTransport
{
  constructor(port) {
    this.allWS = new Set();

    this.caster = null;

    this.wss = new ws.Server({ noServer: true });

    this.wss.on("connection", (ws) => this.initWebSocket(ws));

    this.httpServer = http.createServer((...args) => this.handleRequest(...args));
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = url.parse(request.url).pathname;

      if (pathname === "/ws") {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit("connection", ws, request);
        });
      }
    });

    this.httpServer.listen(port);
  }

  async handleRequest(req, res) {
    const pathname = url.parse(req.url).pathname;
    switch (pathname) {
    case "/":
      res.writeHead(200, {"Content-Type": "text/html"});
      res.end(indexHTML);
      return;
    }

    res.writeHead(404, {"Content-Type": "text/html"});
    res.end("Not Found");
  }

  initWebSocket(ws) {
    for (const packet of this.caster.iterCachedData()) {
      ws.send(JSON.stringify(packet));
    }

    this.allWS.add(ws);

    if (this.allWS.size === 1) {
      this.caster.startCastAll();
    }

    ws.on("close", () => {
      //console.log("Screencast WebSocket Disconnected");
      this.allWS.delete(ws);

      if (this.allWS.size === 0) {
        this.caster.stopCastAll();
      }
    });
  }

  sendAll(packet) {
    packet = JSON.stringify(packet);
    for (const ws of this.allWS) {
      ws.send(packet);
    }
  }

  isActive() {
    return this.allWS.size;
  }
}


// ===========================================================================
class RedisPubSubTransport
{
  constructor(redisUrl, crawlId) {
    this.numConnections = 0;
    this.castChannel = `c:${crawlId}:cast`;
    this.ctrlChannel = `c:${crawlId}:ctrl`;

    this.init(redisUrl);
  }

  async init(redisUrl) {
    this.redis = await initRedis(redisUrl);

    const subRedis = await initRedis(redisUrl);

    await subRedis.subscribe(this.ctrlChannel);

    subRedis.on("message", async (channel, message) => {
      if (channel !== this.ctrlChannel) {
        return;
      }

      switch (message) {
      case "connect":
        this.numConnections++;
        if (this.numConnections === 1) {
          this.caster.startCastAll();
        } else {
          for (const packet of this.caster.iterCachedData()) {
            await this.sendAll(packet);
          }
        }
        break;

      case "disconnect":
        this.numConnections--;
        if (this.numConnections === 0) {
          this.caster.stopCastAll();
        }
        break;
      }
    });
  }

  async sendAll(packet) {
    await this.redis.publish(this.castChannel, JSON.stringify(packet));
  }

  async isActive() {
    const result = await this.redis.pubsub("numsub", this.castChannel);
    return (result.length > 1 ? result[1] > 0: false);
  }
}


// ===========================================================================
class ScreenCaster
{
  constructor(transport, numWorkers) {
    this.transport = transport;
    this.transport.caster = this;

    this.caches = new Map();
    this.urls = new Map();

    this.targets = new Map();

    // todo: make customizable
    this.maxWidth = 640;
    this.maxHeight = 480;

    this.initMsg = {
      msg: "init",
      width: this.maxWidth,
      height: this.maxHeight,
      browsers: numWorkers
    };
  }

  *iterCachedData() {
    yield this.initMsg;
    const msg = "screencast";
    for (const id of this.caches.keys()) {
      const data = this.caches.get(id);
      const url = this.urls.get(id);
      yield {msg, id, url, data};
    }
  }

  detectClose(target) {
    const context = target.browserContext();

    if (context.__destroy_added) {
      return;
    }

    context.on("targetdestroyed", (target) => {
      this.endTarget(target);
    });

    context.__destroy_added = true;
  }

  async screencastTarget(target, currUrl) {
    const id = target._targetId;

    this.urls.set(id, currUrl);

    if (this.targets.has(id)) {
      return;
    }

    this.detectClose(target);

    const cdp = await target.createCDPSession();

    this.targets.set(id, cdp);
    //this.urls.set(id, target.url());

    const msg = "screencast";

    cdp.on("Page.screencastFrame", async (resp) => {
      const data = resp.data;
      const sessionId = resp.sessionId;
      const url = target.url();

      this.caches.set(id, data);
      this.urls.set(id, url);

      //if (url !== "about:blank") {
      await this.transport.sendAll({msg, id, data, url});
      //}

      try {
        await cdp.send("Page.screencastFrameAck", {sessionId});
      } catch(e) {
        //console.log("Ack Failed, probably window/tab already closed", e);
      }
    });

    if (await this.transport.isActive()) {
      await this.startCast(cdp);
    }
  }

  async endAllTargets() {
    const targetIds = this.targets.keys();

    for (const key of targetIds) {
      await this.endTargetById(key);
    }
  }

  async endTarget(target) {
    await this.endTargetById(target._targetId);
  }

  async endTargetById(id) {
    this.caches.delete(id);
    this.urls.delete(id);

    const cdp = this.targets.get(id);

    if (cdp) {
      try {
        await this.stopCast(cdp);
        await cdp.detach();
      } catch (e) {
        // already detached
      }
    }

    await this.transport.sendAll({msg: "close", id});

    this.targets.delete(id);
  }

  async startCast(cdp) {
    if (cdp._startedCast) {
      return;
    }

    cdp._startedCast = true;

    await cdp.send("Page.startScreencast", {format: "png", everyNthFrame: 2, maxWidth: this.maxWidth, maxHeight: this.maxHeight});
  }

  async stopCast(cdp) {
    if (!cdp._startedCast) {
      return;
    }

    cdp._startedCast = false;
    try {
      await cdp.send("Page.stopScreencast");
    } catch (e) {
      // likely already stopped
    }
  }

  startCastAll() {
    const promises = [];

    for (const cdp of this.targets.values()) {
      promises.push(this.startCast(cdp));
    }

    return Promise.allSettled(promises);
  }

  stopCastAll() {
    const promises = [];

    for (const cdp of this.targets.values()) {
      promises.push(this.stopCast(cdp));
    }

    return Promise.allSettled(promises);
  }
}

module.exports = { ScreenCaster, WSTransport, RedisPubSubTransport };
