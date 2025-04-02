import ws, { type WebSocket } from "ws";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import url from "url";
import fs from "fs";

import { initRedis } from "./redis.js";
import { logger } from "./logger.js";
import { type Duplex } from "stream";
import { type CDPSession, type Page } from "puppeteer-core";
import { type WorkerId } from "./state.js";
import type Redis from "ioredis";

const indexHTML = fs.readFileSync(
  new URL("../../html/screencast.html", import.meta.url),
  { encoding: "utf8" },
);

// ===========================================================================
class WSTransport {
  allWS = new Set<WebSocket>();
  // eslint-disable-next-line no-use-before-define
  caster!: ScreenCaster;
  wss: ws.Server;
  httpServer: Server;

  constructor(port: number) {
    this.allWS = new Set();

    this.wss = new ws.Server({ noServer: true });

    this.wss.on("connection", (ws: WebSocket) => this.initWebSocket(ws));

    this.httpServer = http.createServer((...args) =>
      this.handleRequest(...args),
    );
    this.httpServer.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = url.parse(request.url || "").pathname;

        if (pathname === "/ws") {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit("connection", ws, request);
          });
        }
      },
    );

    this.httpServer.listen(port);
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const pathname = url.parse(req.url || "").pathname;
    switch (pathname) {
      case "/":
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(indexHTML);
        return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("Not Found");
  }

  initWebSocket(ws: WebSocket) {
    for (const packet of this.caster.iterCachedData()) {
      ws.send(JSON.stringify(packet));
    }

    this.allWS.add(ws);

    logger.debug(
      "New Screencast Conn",
      { total: this.allWS.size },
      "screencast",
    );

    if (this.allWS.size === 1) {
      this.caster
        .startCastAll()
        .catch((e) => logger.warn("error starting cast", e, "screencast"));
    }

    ws.on("close", () => {
      //console.log("Screencast WebSocket Disconnected");
      this.allWS.delete(ws);

      if (this.allWS.size === 0) {
        this.caster
          .stopCastAll()
          .catch((e) => logger.warn("error stopping cast", e, "screencast"));
      }
    });
  }

  sendAll(packet: unknown) {
    const packetStr = JSON.stringify(packet);
    for (const ws of this.allWS) {
      ws.send(packetStr);
    }
  }

  isActive() {
    return this.allWS.size;
  }
}

// ===========================================================================
class RedisPubSubTransport {
  numConnections: number = 0;
  castChannel: string;
  // eslint-disable-next-line no-use-before-define
  caster!: ScreenCaster;
  ctrlChannel: string;
  redis!: Redis;

  constructor(redisUrl: string, crawlId: string) {
    this.castChannel = `c:${crawlId}:cast`;
    this.ctrlChannel = `c:${crawlId}:ctrl`;

    this.init(redisUrl).catch((e) =>
      logger.warn("error starting cast", e, "screencast"),
    );
  }

  async init(redisUrl: string) {
    this.redis = await initRedis(redisUrl);

    const subRedis = await initRedis(redisUrl);

    await subRedis.subscribe(this.ctrlChannel);

    subRedis.on("message", async (channel: string, message: string) => {
      if (channel !== this.ctrlChannel) {
        return;
      }

      switch (message) {
        case "connect":
          this.numConnections++;
          if (this.numConnections === 1) {
            await this.caster.startCastAll();
          } else {
            for (const packet of this.caster.iterCachedData()) {
              await this.sendAll(packet);
            }
          }
          break;

        case "disconnect":
          this.numConnections--;
          if (this.numConnections === 0) {
            await this.caster.stopCastAll();
          }
          break;
      }
    });
  }

  async sendAll(packet: unknown) {
    await this.redis.publish(this.castChannel, JSON.stringify(packet));
  }

  async isActive() {
    const result = (await this.redis.pubsub(
      "NUMSUB",
      this.castChannel,
    )) as number[];
    return result.length > 1 ? result[1] > 0 : false;
  }
}

type CDPSessionWithCastInfo = CDPSession & { _startedCast?: boolean };

// ===========================================================================
class ScreenCaster {
  transport: WSTransport;
  caches = new Map<WorkerId, string>();
  urls = new Map<WorkerId, string>();
  cdps = new Map<WorkerId, CDPSession>();
  maxWidth = 640;
  maxHeight = 360;
  initMsg: {
    msg: "init";
    width: number;
    height: number;
    browsers: number;
  };

  constructor(transport: WSTransport, numWorkers: number, ratio?: number) {
    this.transport = transport;
    this.transport.caster = this;

    if (ratio) {
      this.maxHeight = this.maxWidth / ratio;
    }

    this.initMsg = {
      msg: "init",
      width: this.maxWidth,
      height: this.maxHeight,
      browsers: numWorkers,
    };
  }

  *iterCachedData() {
    yield this.initMsg;
    const msg = "screencast";
    for (const id of this.caches.keys()) {
      const data = this.caches.get(id);
      const url = this.urls.get(id);
      yield { msg, id, url, data };
    }
  }

  async screencastPage(page: Page, cdp: CDPSession, id: WorkerId) {
    this.urls.set(id, page.url());

    // shouldn't happen, getting duplicate cdp
    if (this.cdps.get(id) === cdp) {
      logger.warn("worker already registered", { workerid: id }, "screencast");
      return;
    }

    this.cdps.set(id, cdp);

    const msg = "screencast";

    cdp.on("Page.screencastFrame", async (resp) => {
      const data = resp.data;
      const sessionId = resp.sessionId;
      const url = page.url();

      logger.debug("screencastFrame", { workerid: id, url }, "screencast");

      // keep previous data cached if just showing about:blank
      if (url && !url.startsWith("about:blank")) {
        this.caches.set(id, data);
        this.urls.set(id, url);

        this.transport.sendAll({ msg, id, data, url });
      }

      try {
        await cdp.send("Page.screencastFrameAck", { sessionId });
      } catch (e) {
        //console.log("Ack Failed, probably window/tab already closed", e);
      }
    });

    if (this.transport.isActive()) {
      await this.startCast(cdp, id);
    }
  }

  async stopAll() {
    for (const key of this.cdps.keys()) {
      await this.stopById(key);
    }
  }

  async stopById(id: WorkerId, sendClose = false) {
    this.caches.delete(id);
    this.urls.delete(id);

    const cdp = this.cdps.get(id);

    if (cdp) {
      try {
        await this.stopCast(cdp, id);
      } catch (e) {
        // already detached
      }
    }

    if (sendClose) {
      this.transport.sendAll({ msg: "close", id });
    }

    this.cdps.delete(id);
  }

  async startCast(cdp: CDPSession, id: WorkerId) {
    if ((cdp as CDPSessionWithCastInfo)._startedCast) {
      return;
    }

    (cdp as CDPSessionWithCastInfo)._startedCast = true;

    logger.info("Started Screencast", { workerid: id }, "screencast");

    await cdp.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
    });
  }

  async stopCast(cdp: CDPSession, id: WorkerId) {
    if (!(cdp as CDPSessionWithCastInfo)._startedCast) {
      return;
    }

    (cdp as CDPSessionWithCastInfo)._startedCast = false;

    logger.info("Stopping Screencast", { workerid: id }, "screencast");

    try {
      await cdp.send("Page.stopScreencast");
    } catch (e) {
      // likely already stopped
    }
  }

  startCastAll() {
    const promises = [];

    for (const [id, cdp] of this.cdps.entries()) {
      promises.push(this.startCast(cdp, id));
    }

    return Promise.allSettled(promises);
  }

  stopCastAll() {
    const promises = [];

    for (const [id, cdp] of this.cdps.entries()) {
      promises.push(this.stopCast(cdp, id));
    }

    return Promise.allSettled(promises);
  }
}

export { ScreenCaster, WSTransport, RedisPubSubTransport };
