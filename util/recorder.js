import fsp from "fs/promises";
import path from "path";
import os from "os";

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
  constructor({workerid, archivesDir, crawler}) {
    this.workerid = workerid;
    this.crawler = crawler;

    this.queue = new PQueue({concurrency: 1});

    this.pendingRequests = new Map();

    this.logDetails = {};
    this.skipping = false;

    this.initFH(archivesDir);
  }

  async initFH(archivesDir) {
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
      if (params.response) {
        const reqresp = this.pendingReqResp(params.requestId, true);
        if (reqresp) {
          reqresp.fillResponseReceived(params);
        }
      }
    });

    cdp.on("Network.responseReceivedExtraInfo", (params) => {
      logger.debug("Network.responseReceivedExtraInfo", {requestId: params.requestId, ...this.logDetails}, "recorderNetwork");
      const reqresp = this.pendingReqResp(params.requestId, true);
      if (reqresp) {
        reqresp.fillResponseReceivedExtraInfo(params);
      }
    });

    // Request

    cdp.on("Network.requestWillBeSent", (params) => {
      // only handling redirect, committing last response in redirect chain
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

  async handleRedirectResponse(params) {
    const { requestId } = params;

    const reqresp = this.removeReqResp(requestId);
    if (!reqresp) {
      return;
    }
    reqresp.fillResponseRedirect(params);
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
        logger.warn("Request load failed", {url: reqresp.url, errorText: params.errorText, ...this.logDetails}, "recorder");
      }
    }
  }

  handleLoadingFinished(params) {
    const reqresp = this.removeReqResp(params.requestId);

    if (!reqresp || !reqresp.url) {
      //console.log("unknown request finished: " + params.requestId);
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
    let payload;

    const { request } = params;
    const { url } = request;

    if (params.responseErrorReason) {
      logger.warn("Skipping failed response", {url, reason: params.responseErrorReason, ...this.logDetails}, "recorder");
      return false;
    }

    if (params.responseStatusCode === 206) {
      logger.debug("Skip 206 Response", {url, ...this.logDetails}, "recorder");
      return false;
    }

    const id = params.networkId || params.requestId;

    const reqresp = this.pendingReqResp(id);
    if (!reqresp) {
      return false;
    }

    reqresp.fillFetchRequestPaused(params);

    if (this.noResponseForStatus(params.responseStatusCode)) {
      payload = new Uint8Array();
    } else {
      try {
        const { requestId } = params;
        logger.debug("Fetching response", {sizeExpected: this._getContentLen(params.responseHeaders), url, ...this.logDetails}, "recorder");
        const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", {requestId});
        payload = Buffer.from(body, base64Encoded ? "base64" : "utf-8");
      } catch (e) {
        logger.warn("Failed to load response body", {url, ...this.logDetails}, "recorder");
        return false;
      }
    }

    const result = await this.rewriteResponse(params, payload, reqresp.extraOpts, cdp);
    const changed = result.changed;

    if (!this.fh) {
      logger.debug("No output file, skipping recording", {url, ...this.logDetails}, "recorder");
      return changed;
    }

    payload = result.payload;
    reqresp.payload = payload;

    if (!payload) {
      logger.error("Unable to get payload skipping recording", {url, ...this.logDetails}, "recorder");
      this.removeReqResp(id);
    }

    return changed;
  }

  //todo
  async isDupeByUrl(url) {
    return !await this.crawler.crawlState.redis.hsetnx("dedup:u", url, "1");
  }

  startPage({pageid, url}) {
    this.pageid = pageid;
    this.logDetails = {page: url, workerid: this.workerid};
    this.pendingRequests = new Map();
    this.skipping = false;
  }

  async finishPage() {
    const pendingRequests = this.pendingRequests;
    this.skipping = true;

    let numPending = pendingRequests.size;

    while (numPending && !this.crawler.interrupted) {
      const pending = [];
      for (const [requestId, reqresp] of pendingRequests.entries()) {
        pending.push({requestId, url: reqresp.url});
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

  async rewriteResponse(params, payload, extraOpts, cdp) {
    let changed = false;

    if (!payload.length) {
      return {payload, changed};
    }

    let newString = null;
    let string = null;

    const url = params.request.url;

    const ct = this._getContentType(params.responseHeaders);

    switch (ct) {
    case "application/x-mpegURL":
    case "application/vnd.apple.mpegurl":
      string = payload.toString("utf-8");
      newString = rewriteHLS(string, {save: extraOpts});
      break;

    case "application/dash+xml":
      string = payload.toString("utf-8");
      newString = rewriteDASH(string, {save: extraOpts});
      break;

    case "text/html":
    case "application/json":
    case "text/javascript":
    case "application/javascript":
    case "application/x-javascript": {
      const rw = baseDSRules.getRewriter(params.request.url);

      if (rw !== baseDSRules.defaultRewriter) {
        string = payload.toString("utf-8");
        newString = rw.rewrite(string, {live: true, save: extraOpts});
      }
      break;
    }
    }

    if (!newString) {
      return {payload, changed};
    }

    if (newString !== string) {
      extraOpts.rewritten = 1;
      const encoder = new TextEncoder();
      logger.debug("Content Rewritten", {url, ...this.logDetails}, "recorder");
      payload = encoder.encode(newString);
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

    return {payload, changed};
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

    if (await this.isDupeByUrl(url)) {
      logger.debug("URL already encountered, skipping recording", {url, ...this.logDetails}, "recorder");
      return;
    }

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

      if (Object.keys(reqresp.extraOpts).length) {
        warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
      }

      return WARCRecord.create({
        url, date, warcVersion, type: "response", warcHeaders,
        httpHeaders, statusline}, [reqresp.payload]);
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
