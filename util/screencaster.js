const ws = require("ws");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const SingleBrowserImplementation = require("puppeteer-cluster/dist/concurrency/SingleBrowserImplementation").default;

const indexHTML = fs.readFileSync(path.join(__dirname, "..", "screencast", "index.html"), {encoding: "utf8"});


// ===========================================================================
class ScreenCaster
{
  constructor(cluster, port) {
    this.cluster = cluster;

    this.httpServer = http.createServer((req, res) => {
      const pathname = url.parse(req.url).pathname;
      if (pathname === "/") {
        res.writeHead(200, {"Content-Type": "text/html"});
        res.end(indexHTML);
      } else {
        res.writeHead(404, {"Content-Type": "text/html"});
        res.end("Not Found");
      }
    });

    this.allWS = new Set();

    this.targets = new Map();
    this.caches = new Map();
    this.urls = new Map();

    this.wss = new ws.Server({ noServer: true });

    this.wss.on("connection", (ws) => this.initWebSocket(ws));

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

  initWebSocket(ws) {
    for (const id of this.targets.keys()) {
      const data = this.caches.get(id);
      const url = this.urls.get(id);
      const msg = {"msg": "newTarget", id, url, data};
      ws.send(JSON.stringify(msg));
    }

    this.allWS.add(ws);

    if (this.allWS.size === 1) {
      this.startCastAll();
    }

    ws.on("close", () => {
      //console.log("Screencast WebSocket Disconnected");
      this.allWS.delete(ws);

      if (this.allWS.size === 0) {
        this.stopCastAll();
      }
    });
  }

  sendAll(msg) {
    msg = JSON.stringify(msg);
    for (const ws of this.allWS) {
      ws.send(msg);
    }
  }

  async newTarget(target) {
    const cdp = await target.createCDPSession();
    const id = target._targetId;
    const url = target.url();

    this.targets.set(id, cdp);
    this.urls.set(id, url);

    this.sendAll({"msg": "newTarget", id, url});

    cdp.on("Page.screencastFrame", async (resp) => {
      const data = resp.data;
      const sessionId = resp.sessionId;

      this.sendAll({"msg": "screencast", id, data});
      this.caches.set(id, data);
      try {
        await cdp.send("Page.screencastFrameAck", {sessionId});
      } catch(e) {
        //console.log("Ack Failed, probably window/tab already closed", e);
      }
    });

    if (this.allWS.size) {
      await this.startCast(cdp);
    }
  }

  async endTarget(target) {
    const id = target._targetId;
    const cdp = this.targets.get(id);
    if (!cdp) {
      return;
    }

    await this.stopCast(cdp);

    this.sendAll({"msg": "endTarget", id});

    this.targets.delete(id);
    this.caches.delete(id);
    this.urls.delete(id);

    try {
      await cdp.detach();
    } catch (e) {
      // already detached
    }
  }

  async startCast(cdp) {
    if (cdp._startedCast) {
      return;
    }

    cdp._startedCast = true;

    await cdp.send("Page.startScreencast", {format: "png", everyNthFrame: 1, maxWidth: 1024, maxHeight: 768});
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


// ===========================================================================
class NewWindowPage extends SingleBrowserImplementation {
  async init() {
    await super.init();

    this.newTargets = [];

    this.nextPromise();

    this.mainPage = await this.browser.newPage();

    this.pages = [];
    this.reuse = true;

    await this.mainPage.goto("about:blank");

    this.mainTarget = this.mainPage.target();

    this.browser.on("targetcreated", (target) => {
      if (this._nextTarget && target.opener() === this.mainTarget) {
        this.newTargets.push(target);
        this._nextTarget();
        this.nextPromise();
      }
    });
  }

  nextPromise() {
    this._nextPromise = new Promise((resolve) => this._nextTarget = resolve);
  }

  async getNewPage() {
    const p = this._nextPromise;

    await this.mainPage.evaluate("window.open('about:blank', '', 'resizable');");

    await p;

    const target = this.newTargets.shift();

    return {page: await target.page() };
  }

  async createResources() {
    if (this.pages.length) {
      return {page: this.pages.shift()};
    }
    return await this.getNewPage();
  }

  async freeResources(resources) {
    if (this.reuse) {
      this.pages.push(resources.page);
    } else {
      await resources.page.close();
    }
  }
}



module.exports = { ScreenCaster, NewWindowPage };
