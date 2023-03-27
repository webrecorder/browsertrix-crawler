import fsp from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

import { createHash } from "node:crypto";

import PQueue from "p-queue";

import { logger, errJSON } from "./logger.js";
import { sleep, timestampNow } from "./timing.js";
import { RequestResponseInfo } from "./reqresp.js";

import { baseRules as baseDSRules } from "@webrecorder/wabac/src/rewrite/index.js";
import { rewriteDASH, rewriteHLS } from "@webrecorder/wabac/src/rewrite/rewriteVideo.js";

import { WARCRecord, WARCSerializer } from "warcio";


// =================================================================
export class Recorder
{
  constructor({workerid, collDir, crawler}) {
    this.workerid = workerid;
    this.crawler = crawler;

    this.queue = new PQueue({concurrency: 1});

    this.pendingRequests = null;
    this.skipIds = null;

    this.logDetails = {};
    this.skipping = false;

    this.initFH(collDir);
  }

  async initFH(collDir) {
    const archivesDir = path.join(collDir, "archive");
    this.tempdir = path.join(collDir, "tmp");

    await fsp.mkdir(this.tempdir, {recursive: true});

    await fsp.mkdir(archivesDir, {recursive: true});

    const crawlId = process.env.CRAWL_ID || os.hostname();
    this.fh = await fsp.open(path.join(archivesDir, `rec-${crawlId}-${timestampNow()}-${this.workerid}.warc`), "a");
  }

  async onCreatePage({cdp}) {
    // Fetch

    cdp.on("Fetch.requestPaused", (params) => {
      logger.debug("Fetch.requestPaused", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      this.handleRequestPaused(params, cdp);
    });

    // Response
    cdp.on("Network.responseReceived", (params) => {
      // handling to fill in security details
      logger.debug("Network.responseReceived", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      this.handleResponseReceived(params);
    });

    cdp.on("Network.responseReceivedExtraInfo", (params) => {
      logger.debug("Network.responseReceivedExtraInfo", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      const reqresp = this.pendingReqResp(params.requestId);
      if (reqresp) {
        reqresp.fillResponseReceivedExtraInfo(params);
      }
    });

    // Request

    cdp.on("Network.requestWillBeSent", (params) => {
      // only handling redirect here, committing last response in redirect chain
      // request data stored from requestPaused
      if (params.redirectResponse) {
        logger.debug("Network.requestWillBeSent after redirect", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
        this.handleRedirectResponse(params);
      }
    });

    cdp.on("Network.requestServedFromCache", (params) => {
      logger.debug("Network.requestServedFromCache", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      this.removeReqResp(params.requestId);
    });

    // cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
    //   logger.debug("Network.requestWillBeSentExtraInfo", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
    //   if (!this.shouldSkip(null, params.headers, null)) {
    //     const reqresp = this.pendingReqResp(params.requestId, true);
    //     if (reqresp) {
    //       reqresp.fillRequestExtraInfo(params);
    //     }
    //   }
    // });

    // Loading
    cdp.on("Network.loadingFinished", (params) => {
      logger.debug("Network.loadingFinished", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      this.handleLoadingFinished(params);
    });

    cdp.on("Network.loadingFailed", (params) => {
      logger.debug("Network.loadingFailed", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      this.handleLoadingFailed(params);
    });

    await cdp.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Response"}]});
    await cdp.send("Network.enable");
  }

  async handleResponseReceived(params) {
    const { requestId, response } = params;

    const reqresp = this.pendingReqResp(requestId);
    if (!reqresp) {
      return;
    }

    reqresp.fillResponse(response);
  }

  async handleRedirectResponse(params) {
    const { requestId, redirectResponse } = params;

    // remove and serialize now as may redirect chain may reuse same requestId
    const reqresp = this.removeReqResp(requestId);
    if (!reqresp) {
      return;
    }

    reqresp.fillResponse(redirectResponse);
    this.serializeToWARC(reqresp);
  }

  handleLoadingFailed(params) {
    const reqresp = this.removeReqResp(params.requestId);
    if (reqresp && reqresp.status !== 206) {
      // check if this is a false positive -- a valid download that's already been fetched
      // the abort is just for page, but download will succeed
      if (params.type === "Document" && 
              params.errorText === "net::ERR_ABORTED" &&
              reqresp.isValidBinary()) {
        this.serializeToWARC(reqresp);
      } else if (params.errorText === "net::ERR_BLOCKED_BY_CLIENT") {
        logger.warn("Request blocked", {url: reqresp.url, errorText: params.errorText, ...this.logDetails}, "recorder");
      } else {
        logger.warn("Request load failed", {url: reqresp.url, errorText: params.errorText, ...this.logDetails}, "recorder");
      }
    }
  }

  handleLoadingFinished(params) {
    const reqresp = this.removeReqResp(params.requestId);

    if (!reqresp || !reqresp.url) {
      return;
    }

    if (!this.isValidUrl(reqresp.url)) {
      return;
    }

    this.serializeToWARC(reqresp);
  }

  async handleRequestPaused(params, cdp) {
    const { requestId, request, responseStatusCode, responseErrorReason, resourceType } = params;
    const { method, headers, url } = request;

    let continued = false;

    try {
      if (responseStatusCode && !responseErrorReason && !this.shouldSkip(method, headers, resourceType)) {
        continued = await this.handleFetchResponse(params, cdp);
      }
    } catch (e) {
      logger.error("Error handling response, probably skipping URL", {url, ...errJSON(e), ...this.logDetails}, "recorder");
    }

    if (!continued) {
      try {
        await cdp.send("Fetch.continueResponse", {requestId});
      } catch (e) {
        logger.error("continueResponse failed", {url, ...errJSON(e), ...this.logDetails}, "recorder");
      }
    }
  }

  async handleFetchResponse(params, cdp) {
    const { request } = params;
    const { url } = request;
    const {networkId, requestId, responseErrorReason, responseStatusCode, responseHeaders} = params;

    if (responseErrorReason) {
      logger.warn("Skipping failed response", {url, reason: params.responseErrorReason, ...this.logDetails}, "recorder");
      return false;
    }

    if (await this.isDupeByUrl(url)) {
      logger.debug("URL already encountered, skipping recording", {url, networkId, ...this.logDetails}, "recorder");
      this.skipIds.add(networkId);
      this.removeReqResp(networkId);
      return false;
    }

    const contentLen = this._getContentLen(responseHeaders);

    if (params.responseStatusCode === 206) {
      const range = this._getContentRange(responseHeaders);
      if (range === `bytes 0-${contentLen - 1}/${contentLen}`) {
        logger.debug("Keep 206 Response, Full Range", {range, contentLen, url, networkId, ...this.logDetails}, "recorder");
      } else {
        logger.debug("Skip 206 Response", {range, contentLen, url, ...this.logDetails}, "recorder");
        return false;
      }
    }

    const reqresp = this.pendingReqResp(networkId);
    if (!reqresp) {
      return false;
    }

    reqresp.fillFetchRequestPaused(params);

    if (this.noResponseForStatus(responseStatusCode)) {
      reqresp.payload = new Uint8Array();
      return false;
    }

    if (contentLen && contentLen > 100000000) {
      const payload = new PayloadBuffer(this.tempdir, contentLen);
      reqresp.streaming = payload;

      await payload.load(cdp, requestId);

      // continue with empty body to avoid sending full stream back
      const body = "".toString("base64");

      await cdp.send("Fetch.fulfillRequest", {
        requestId, responseHeaders, body,
        responseCode: params.responseStatusCode,
      });

      if (payload.length === contentLen) {
        logger.debug("Streaming fetch done", {size: payload.length, expected: contentLen, url, ...this.logDetails}, "recorder");
        reqresp.payload = payload;
      } else {
        logger.warn("Streaming response size mismatch, skipping", {size: payload.length, expected: contentLen, url, ...this.logDetails}, "recorder");
        this.removeReqResp(networkId);
      }

      return true;
    }

    try {
      logger.debug("Fetching response", {sizeExpected: this._getContentLen(params.responseHeaders), url, networkId, ...this.logDetails}, "recorder");
      const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", {requestId});
      reqresp.payload = Buffer.from(body, base64Encoded ? "base64" : "utf-8");
      logger.debug("Fetch done", {size: reqresp.payload.length, url, networkId, ...this.logDetails}, "recorder");
    } catch (e) {
      logger.warn("Failed to load response body", {url, ...this.logDetails}, "recorder");
      return false;
    }

    const changed = await this.rewriteResponse(params, reqresp, cdp);

    if (!this.fh) {
      logger.debug("No output file, skipping recording", {url, ...this.logDetails}, "recorder");
      return changed;
    }


    if (!reqresp.payload) {
      logger.error("Unable to get payload skipping recording", {url, ...this.logDetails}, "recorder");
      this.removeReqResp(networkId);
    }

    return changed;
  }

  //todo
  async isDupeByUrl(url) {
    //return !await this.crawler.crawlState.redis.hsetnx("dedup:u", url, "1");
    await this.crawler.crawlState.redis.sadd("dedup:s", url) === 1;
  }

  startPage({pageid, url}) {
    this.pageid = pageid;
    this.logDetails = {page: url, workerid: this.workerid};
    this.pendingRequests = new Map();
    this.skipIds = new Set();
    this.skipping = false;
  }

  async finishPage() {
    const pendingRequests = this.pendingRequests;
    this.skipping = true;

    for (const [requestId, reqresp] of pendingRequests.entries()) {
      if (reqresp.payload) {
        this.removeReqResp(requestId);
        await this.serializeToWARC(reqresp);
      // no url, likely invalid
      } else if (!reqresp.url) {
        this.removeReqResp(requestId);
      }
    }

    let numPending = pendingRequests.size;

    while (numPending && !this.crawler.interrupted) {
      const pending = [];
      for (const [requestId, reqresp] of pendingRequests.entries()) {
        const url = reqresp.url;
        const entry = {requestId, url};
        if (reqresp.streaming) {
          entry.size = reqresp.streaming.length;
          entry.expectedSize = reqresp.streaming.expectedSize;
        }
        pending.push(entry);
      }

      logger.debug("Finishing pending requests for page", {numPending, pending, ...this.logDetails}, "recorder");
      await sleep(5.0);
      numPending = pendingRequests.size;
    }
  }

  async onClosePage() {

  }

  async onDone() {
    await this.queue.onIdle();

    const fh = this.fh;
    this.fh = null;

    if (fh) {
      await fh.sync();
      await fh.close();
    }
  }

  shouldSkip(method, headers, resourceType) {
    if (headers && !method) {
      method = headers[":method"];
    }

    if (method === "OPTIONS" || method === "HEAD") {
      return true;
    }

    if (["EventSource", "WebSocket", "Ping"].includes(resourceType)) {
      return true;
    }

    // beacon
    if (resourceType === "Other" && method === "POST") {
      return true;
    }

    // skip eventsource, resourceType may not be set correctly
    if (headers && (headers["accept"] === "text/event-stream" || headers["Accept"] === "text/event-stream")) {
      return true;
    }

    return false;
  }

  async rewriteResponse(params, reqresp, cdp) {
    let changed = false;

    if (!reqresp.payload.length) {
      return changed;
    }

    let newString = null;
    let string = null;

    const url = params.request.url;

    const ct = this._getContentType(params.responseHeaders);

    switch (ct) {
    case "application/x-mpegURL":
    case "application/vnd.apple.mpegurl":
      string = reqresp.payload.toString("utf-8");
      newString = rewriteHLS(string, {save: reqresp.extraOpts});
      break;

    case "application/dash+xml":
      string = reqresp.payload.toString("utf-8");
      newString = rewriteDASH(string, {save: reqresp.extraOpts});
      break;

    case "text/html":
    case "application/json":
    case "text/javascript":
    case "application/javascript":
    case "application/x-javascript": {
      const rw = baseDSRules.getRewriter(params.request.url);

      if (rw !== baseDSRules.defaultRewriter) {
        string = reqresp.payload.toString("utf-8");
        newString = rw.rewrite(string, {live: true, save: reqresp.extraOpts});
      }
      break;
    }
    }

    if (!newString) {
      return changed;
    }

    if (newString !== string) {
      reqresp.extraOpts.rewritten = 1;
      const encoder = new TextEncoder();
      logger.debug("Content Rewritten", {url, ...this.logDetails}, "recorder");
      reqresp.payload = encoder.encode(newString);
    }

    const base64Str = Buffer.from(newString).toString("base64");

    try {
      await cdp.send("Fetch.fulfillRequest",
        {"requestId": params.requestId,
          "responseCode": params.responseStatusCode,
          "responseHeaders": params.responseHeaders,
          "body": base64Str
        });
      changed = true;
    } catch (e) {
      logger.warn("Fulfill Failed", {url, ...this.logDetails, ...errJSON(e)}, "recorder");
    }

    return changed;
  }

  _getContentType(headers) {
    for (let header of headers) {
      if (header.name.toLowerCase() === "content-type") {
        return header.value.split(";")[0];
      }
    }

    return null;
  }

  _getContentLen(headers) {
    for (let header of headers) {
      if (header.name.toLowerCase() === "content-length") {
        return Number(header.value);
      }
    }

    return -1;
  }

  _getContentRange(headers) {
    for (let header of headers) {
      if (header.name.toLowerCase() === "content-range") {
        return header.value;
      }
    }

    return null;
  }

  noResponseForStatus(status) {
    return (!status || status === 204 || (status >= 300 && status < 400));
  }

  isValidUrl(url) {
    return url && (url.startsWith("https:") || url.startsWith("http:"));
  }

  pendingReqResp(requestId, reuseOnly = false) {
    if (!this.pendingRequests.has(requestId)) {
      if (reuseOnly || !requestId) {
        return null;
      }
      if (this.skipIds.has(requestId)) {
        logger.debug("Skipping ignored id", {requestId}, "recorder");
        return null;
      }
      if (this.skipping) {
        logger.warn("Skipping request, page already finished", this.logDetails, "recorder");
        return null;
      }
      this.pendingRequests.set(requestId, new RequestResponseInfo(requestId));
    } else if (requestId !== this.pendingRequests.get(requestId).requestId) {
      console.error("Wrong Req Id!");
    }

    return this.pendingRequests.get(requestId);
  }

  removeReqResp(requestId) {
    const reqresp = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    return reqresp;
  }

  async serializeToWARC(reqresp) {
    if (!reqresp.payload) {
      return;
    }

    const url = reqresp.url;

    // if (await this.isDupeByUrl(url)) {
    //   logger.debug("URL already encountered, skipping recording", {url, ...this.logDetails}, "recorder");
    //   return;
    // }

    const urlParsed = new URL(url);

    const warcVersion = "WARC/1.1";
    const date = new Date().toISOString();

    // response
    const createResponse = () => {
      const statusline = `HTTP/1.1 ${reqresp.status} ${reqresp.statusText}`;

      const { headersDict } = reqresp.getResponseHeadersDict(reqresp.payload.length);
      const httpHeaders = headersDict;

      const warcHeaders = {
        "WARC-Page-ID": this.pageid,
      };

      let body;

      if (reqresp.payload instanceof PayloadBuffer) {
        warcHeaders["WARC-Payload-Digest"] = reqresp.payload.payloadDigest;
        body = reqresp.payload;
      } else {
        body = [reqresp.payload];
      }

      if (Object.keys(reqresp.extraOpts).length) {
        warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
      }

      return WARCRecord.create({
        url, date, warcVersion, type: "response", warcHeaders,
        httpHeaders, statusline}, body);
    };

    // request
    const createRequest = (responseRecord) => {
      const method = reqresp.method;

      const statusline = `${method} ${url.slice(urlParsed.origin.length)} HTTP/1.1`;
      //const statusline = `${method} ${url} HTTP/1.1`;

      const requestBody = reqresp.postData ? [reqresp.postData] : [];

      const { headersDict } = reqresp.getRequestHeadersDict();
      const httpHeaders = headersDict;

      const warcHeaders = {
        "WARC-Concurrent-To": responseRecord.warcHeader("WARC-Record-ID"),
        "WARC-Page-ID": this.pageid,
      };

      return WARCRecord.create({
        url, date, warcVersion, type: "request", warcHeaders,
        httpHeaders, statusline}, requestBody);
    };

    const responseRecord = await createResponse();
    const requestRecord = await createRequest(responseRecord);

    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(responseRecord, {gzip: true})));
    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(requestRecord, {gzip: true})));
  }
}

// =================================================================
class PayloadBuffer
{
  constructor(tempdir, expectedSize) {
    this.tempdir = tempdir;
    this.length = 0;
    this.expectedSize = expectedSize;
    this.filename = path.join(this.tempdir, `${timestampNow()}-${uuidv4()}.data`);

    this._digest = createHash("sha256");
  }

  get payloadDigest() {
    return "sha-256:" + this._digest.digest("hex");
  }

  async load(cdp, requestId) {
    let respFH;

    try {
      const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {requestId});

      respFH = await fsp.open(this.filename, "w");

      while (true) {
        const {data, base64Encoded, eof} = await cdp.send("IO.read", {handle: stream});
        const buff = Buffer.from(data, base64Encoded ? "base64" : "utf-8");
        this._digest.update(buff);
        this.length += buff.length;
        await respFH.write(buff);
        if (eof) {
          break;
        }
      }
      await respFH.sync();
    } catch (e) {
      logger.error("Error streaming ot file", {requestId, filename: this.this.filename, ...errJSON(e), ...this.logDetails}, "recorder");
    } finally {
      await respFH.close();
    }
  }

  async *[Symbol.asyncIterator]() {
    const respFH = await fsp.open(this.filename);
    const reader = await respFH.createReadStream();
    for await (const buff of reader) {
      yield buff;
    }
    try {
      await respFH.close();
      await fsp.unlink(this.filename);
    } catch (e) {
      logger.error("Error closing buffer file", {filename: this.filename, ...errJSON(e), ...this.logDetails}, "recorder");
    }
  }
}
