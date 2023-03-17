import ws from "ws";
import http from "http";
import url from "url";
import fs from "fs";
//import { v4 as uuidv4 } from "uuid";

import { initRedis } from "./redis.js";
import { Logger } from "./logger.js";

const indexHTML = fs.readFileSync(new URL("../html/screencast.html", import.meta.url), {encoding: "utf8"});

const logger = new Logger();


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

    logger.debug("New Screencast Conn", {total: this.allWS.size}, "screencast");

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

    this.cdps = new Map();

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

  async screencastPage(page, id, cdp) {
    //const id = uuidv4();

    this.urls.set(id, page.url());

    if (this.cdps.has(id)) {
      logger.warn("worker already registered", {workerid: id}, "screencast");
      return;
    }

    //const context = page.context();

    this.cdps.set(id, cdp);
    //this.urls.set(id, target.url());

    const msg = "screencast";

    cdp.on("Page.screencastFrame", async (resp) => {
      const data = resp.data;
      const sessionId = resp.sessionId;
      const url = page.url();

      logger.debug("screencastFrame", {workerid: id, url}, "screencast");

      this.caches.set(id, data);
      this.urls.set(id, url);

      if (url && !url.startsWith("about:blank")) {
        await this.transport.sendAll({msg, id, data, url});
      }

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

  async stopAll() {
    for (const key of this.cdps.keys()) {
      await this.stopById(key);
    }
  }

  async stopById(id) {
    this.caches.delete(id);
    this.urls.delete(id);

    const cdp = this.cdps.get(id);

    if (cdp) {
      try {
        await this.stopCast(cdp);
      } catch (e) {
        // already detached
      }
    }

    //await this.transport.sendAll({msg: "close", id});

    this.cdps.delete(id);
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

    for (const cdp of this.cdps.values()) {
      promises.push(this.startCast(cdp));
    }

    return Promise.allSettled(promises);
  }

  stopCastAll() {
    const promises = [];

    for (const cdp of this.cdps.values()) {
      promises.push(this.stopCast(cdp));
    }

    return Promise.allSettled(promises);
  }
}

export { ScreenCaster, WSTransport, RedisPubSubTransport };
