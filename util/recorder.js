import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

import { v4 as uuidv4 } from "uuid";

import PQueue from "p-queue";

import { logger, errJSON } from "./logger.js";
import { sleep, timestampNow } from "./timing.js";
import { RequestResponseInfo } from "./reqresp.js";

import { baseRules as baseDSRules } from "@webrecorder/wabac/src/rewrite/index.js";
import { rewriteDASH, rewriteHLS } from "@webrecorder/wabac/src/rewrite/rewriteVideo.js";

import { WARCRecord, WARCSerializer, WARCRecordBuffer, StreamingWARCSerializer, AsyncIterReader } from "warcio";

const MAX_BROWSER_FETCH_SIZE = 10000000;

const ASYNC_FETCH_DUPE_KEY = "s:fetchdupe";

const WRITE_DUPE_KEY = "s:writedupe";

const encoder = new TextEncoder();

// =================================================================
function logNetwork(/*msg, data*/) {
  // logger.debug(msg, data, "recorderNetwork");
}

// =================================================================
export class Recorder
{
  constructor({workerid, collDir, crawler}) {
    this.workerid = workerid;
    this.crawler = crawler;
    this.crawlState = crawler.crawlState;

    this.queue = new PQueue({concurrency: 1});

    this.fetcherQ = new PQueue({concurrency: 3});

    this.fh = null;

    this.pendingRequests = null;
    this.skipIds = null;

    this.logDetails = {};
    this.skipping = false;

    this.collDir = collDir;

    this.allowFull206 = true;
    this.gzip = true;
    this.useTakeStream = false;
  }

  async initFH() {
    const archivesDir = path.join(this.collDir, "archive");
    this.tempdir = path.join(this.collDir, "tmp");

    await fsp.mkdir(this.tempdir, {recursive: true});

    await fsp.mkdir(archivesDir, {recursive: true});

    const crawlId = process.env.CRAWL_ID || os.hostname();

    this.fh = fs.createWriteStream(path.join(archivesDir, `rec-${crawlId}-${timestampNow()}-${this.workerid}.warc`));
  }

  async onCreatePage({cdp}) {
    // Fetch

    cdp.on("Fetch.requestPaused", (params) => {
      logNetwork("Fetch.requestPaused", {requestId: params.requestId, ...this.logDetails});
      this.handleRequestPaused(params, cdp);
    });

    // Response
    cdp.on("Network.responseReceived", (params) => {
      // handling to fill in security details
      logNetwork("Network.responseReceived", {requestId: params.requestId, ...this.logDetails});
      this.handleResponseReceived(params);
    });

    cdp.on("Network.responseReceivedExtraInfo", (params) => {
      logNetwork("Network.responseReceivedExtraInfo", {requestId: params.requestId, ...this.logDetails});
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
        logNetwork("Network.requestWillBeSent after redirect", {requestId: params.requestId, ...this.logDetails});
        this.handleRedirectResponse(params);
      }
    });

    cdp.on("Network.requestServedFromCache", (params) => {
      logNetwork("Network.requestServedFromCache", {requestId: params.requestId, ...this.logDetails});
      this.removeReqResp(params.requestId);
    });

    cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
      logNetwork("Network.requestWillBeSentExtraInfo", {requestId: params.requestId, ...this.logDetails});
      this.handleRequestExtraInfo(params);
    });

    // Loading
    cdp.on("Network.loadingFinished", (params) => {
      logNetwork("Network.loadingFinished", {requestId: params.requestId, ...this.logDetails});
      this.handleLoadingFinished(params);
    });

    cdp.on("Network.loadingFailed", (params) => {
      logNetwork("Network.loadingFailed", {requestId: params.requestId, ...this.logDetails});
      this.handleLoadingFailed(params);
    });

    await cdp.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Response"}]});
    await cdp.send("Network.enable");
  }

  handleResponseReceived(params) {
    const { requestId, response } = params;

    const reqresp = this.pendingReqResp(requestId);
    if (!reqresp) {
      return;
    }

    reqresp.fillResponse(response);
  }

  handleRequestExtraInfo(params) {
    if (!this.shouldSkip(null, params.headers, null)) {
      const reqresp = this.pendingReqResp(params.requestId, true);
      if (reqresp) {
        reqresp.fillRequestExtraInfo(params);
      }
    }
  }

  handleRedirectResponse(params) {
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
    const { errorText, type, requestId } = params;

    const reqresp = this.pendingReqResp(requestId);
    if (!reqresp) {
      return;
    }

    const { url } = reqresp;

    switch (errorText) {
    case "net::ERR_BLOCKED_BY_CLIENT":
      logNetwork("Request blocked", {url, errorText, ...this.logDetails}, "recorder");
      break;

    case "net::ERR_ABORTED":
      // check if this is a false positive -- a valid download that's already been fetched
      // the abort is just for page, but download will succeed
      if (url && type === "Document" && reqresp.isValidBinary()) {
        this.removeReqResp(requestId);
        this.serializeToWARC(reqresp);
      //} else if (url) {
      } else if (url && reqresp.requestHeaders && reqresp.requestHeaders["x-browsertrix-fetch"]) {
        delete reqresp.requestHeaders["x-browsertrix-fetch"];
        logger.warn("Attempt direct fetch of failed request", {url, ...this.logDetails}, "recorder");
        const fetcher = new AsyncFetcher({tempdir: this.tempdir, reqresp, recorder: this, networkId: requestId});
        this.fetcherQ.add(() => fetcher.load());
        return;
      }
      break;

    default:
      logger.warn("Request failed", {url, errorText, ...this.logDetails}, "recorder");
    }
    this.removeReqResp(requestId);
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
        //logger.warn("continueResponse failed", {url, ...errJSON(e), ...this.logDetails}, "recorder");
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

    const contentLen = this._getContentLen(responseHeaders);

    if (params.responseStatusCode === 206) {
      const range = this._getContentRange(responseHeaders);
      if (this.allowFull206 && range === `bytes 0-${contentLen - 1}/${contentLen}`) {
        logger.debug("Keep 206 Response, Full Range", {range, contentLen, url, networkId, ...this.logDetails}, "recorder");
      } else {
        logger.debug("Skip 206 Response", {range, contentLen, url, ...this.logDetails}, "recorder");
        this.skipIds.add(networkId);
        this.removeReqResp(networkId);
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

    if (contentLen && contentLen > MAX_BROWSER_FETCH_SIZE) {
      const fetcher = new AsyncFetcher({tempdir: this.tempdir, reqresp, expectedSize: contentLen, recorder: this, networkId, requestId, cdp, useTakeStream: this.useTakeStream});
      this.skipIds.add(networkId);
      this.fetcherQ.add(() => fetcher.load());
      return this.useTakeStream;
    }

    try {
      logNetwork("Fetching response", {sizeExpected: this._getContentLen(params.responseHeaders), url, networkId, ...this.logDetails});
      const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", {requestId});
      reqresp.payload = Buffer.from(body, base64Encoded ? "base64" : "utf-8");
      logNetwork("Fetch done", {size: reqresp.payload.length, url, networkId, ...this.logDetails});
    } catch (e) {
      logger.warn("Failed to load response body", {...errJSON(e), url, ...this.logDetails}, "recorder");
      return false;
    }

    const changed = await this.rewriteResponse(params, reqresp, cdp);

    if (!reqresp.payload) {
      logger.error("Unable to get payload skipping recording", {url, ...this.logDetails}, "recorder");
      this.removeReqResp(networkId);
    }

    return changed;
  }

  startPage({pageid, url}) {
    this.pageid = pageid;
    this.logDetails = {page: url, workerid: this.workerid};
    // if (this.pendingRequests && this.pendingRequests.size) {
    //   logger.warn("Interrupting timed out requests, moving to next page", this.logDetails, "recorder");
    // }
    this.pendingRequests = new Map();
    this.skipIds = new Set();
    this.skipping = false;
  }

  async finishPage() {
    //this.skipping = true;

    for (const [requestId, reqresp] of this.pendingRequests.entries()) {
      if (reqresp.payload) {
        this.removeReqResp(requestId);
        await this.serializeToWARC(reqresp);
      // no url, likely invalid
      } else if (!reqresp.url) {
        this.removeReqResp(requestId);
      }
    }

    let numPending = this.pendingRequests.size;

    while (numPending && !this.crawler.interrupted) {
      const pending = [];
      for (const [requestId, reqresp] of this.pendingRequests.entries()) {
        const url = reqresp.url;
        const entry = {requestId, url};
        if (reqresp.expectedSize) {
          entry.expectedSize = reqresp.expectedSize;
        }
        if (reqresp.readSize) {
          entry.readSize = reqresp.readSize;
        }
        pending.push(entry);
      }

      logger.debug("Finishing pending requests for page", {numPending, pending, ...this.logDetails}, "recorder");
      await sleep(5.0);
      numPending = this.pendingRequests.size;
    }

    logger.debug("Finishing Fetcher Queue", this.logDetails, "recorder");
    await this.fetcherQ.onIdle();
  }

  async onClosePage() {

  }

  async onDone() {
    logger.debug("Finishing WARC writing", this.logDetails, "recorder");

    await this.queue.onIdle();

    if (this.fh) {
      await streamFinish(this.fh);
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
        logNetwork("Skipping ignored id", {requestId});
        return null;
      }
      if (this.skipping) {
        //logger.debug("Skipping request, page already finished", this.logDetails, "recorder");
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

    if (reqresp.method === "GET" && !await this.crawlState.addIfNoDupe(WRITE_DUPE_KEY, reqresp.url)) {
      //logger.warn("Skipping dupe", {url: reqresp.url}, "recorder");
      return;
    }

    if (!this.fh) {
      await this.initFH();
    }

    const responseRecord = createResponse(reqresp, this.pageid);
    const requestRecord = createRequest(reqresp, responseRecord, this.pageid);

    this.queue.add(() => writeRecordPair(this.fh, responseRecord, requestRecord, this.logDetails, this.gzip));
  }
}

// =================================================================
class AsyncFetcher extends WARCRecordBuffer
{
  constructor({tempdir, reqresp, expectedSize = -1, recorder, networkId, requestId = null, cdp = null, useTakeStream}) {
    super();
    
    this.reqresp = reqresp;
    this.reqresp.expectedSize = expectedSize;

    this.useTakeStream = useTakeStream;

    this.cdp = cdp;
    this.requestId = requestId;
    this.networkId = networkId;

    this.recorder = recorder;

    this.fh = null;

    this.tempdir = tempdir;
    this.filename = path.join(this.tempdir, `${timestampNow()}-${uuidv4()}.data`);
  }

  async load() {
    const { reqresp, recorder, cdp, requestId, useTakeStream, networkId } = this;
    const { url } = reqresp;

    const { pageid, crawlState, gzip } = recorder;

    try {
      if (reqresp.method === "GET" && !await crawlState.addIfNoDupe(ASYNC_FETCH_DUPE_KEY, url)) {
        return;
      }

      let body = null;

      if (useTakeStream && cdp && requestId) {
        logger.debug("Async started: takeStream", {url}, "recorder");
        body = await this._loadTakeStream(cdp, reqresp, requestId);
      } else {
        logger.debug("Async started: fetch", {url}, "recorder");
        body = await this._loadFetch(reqresp, crawlState);
      }

      const responseRecord = createResponse(reqresp, pageid, body);
      const requestRecord = createRequest(reqresp, responseRecord, pageid);

      const serializer = new StreamingWARCSerializer({gzip});
      await serializer.bufferRecord(responseRecord, this);

      if (reqresp.readSize === reqresp.expectedSize || reqresp.expectedSize < 0) {
        logger.debug("Async fetch: streaming done", {size: reqresp.readSize, expected: reqresp.expectedSize, networkId, url, ...this.logDetails}, "recorder");
        
      } else {
        logger.warn("Async fetch: response size mismatch, skipping", {size: reqresp.readSize, expected: reqresp.expectedSize, url, ...this.logDetails}, "recorder");
        await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url);
        return;
      }

      if (Object.keys(reqresp.extraOpts).length) {
        responseRecord.warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
      }

      recorder.queue.add(() => writeRecordPair(recorder.fh, responseRecord, requestRecord, recorder.logDetails, gzip, serializer));

    } catch (e) {
      logger.error("Error streaming to file", {url, networkId, filename: this.filename, ...errJSON(e), ...this.logDetails}, "recorder");
      await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url);

    } finally {
      recorder.removeReqResp(networkId);
    }
  }

  async _loadFetch(reqresp, crawlState) {
    const { headers } = reqresp.getRequestHeadersDict();
    const { method, url } = reqresp;

    const resp = await fetch(url, {method, headers, body: reqresp.postData || undefined});

    if (reqresp.expectedSize < 0 && resp.headers.get("content-length")) {
      reqresp.expectedSize = Number(resp.headers.get("content-length"));
    }

    if (reqresp.expectedSize === 0) {
      reqresp.payload = new Uint8Array();
      return;

    } else if (!resp.body) {
      logger.error("Empty body, stopping fetch", {url}, "recorder");
      await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url);
      return;
    }

    reqresp.fillFetchResponse(resp);

    return AsyncIterReader.fromReadable(resp.body.getReader());
  }

  async _loadTakeStream(cdp, reqresp, requestId) {
    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {requestId});

    const { responseHeadersList, status, url } = reqresp;

    const logDetails = this.logDetails;

    async function* takeStreamIter() {
      try {
        while (true) {
          const {data, base64Encoded, eof} = await cdp.send("IO.read", {handle: stream});
          const buff = Buffer.from(data, base64Encoded ? "base64" : "utf-8");
          //console.log("takeStream got: ", requestId, buff.length, eof, url);
          yield buff;
          if (eof) {
            break;
          }
        }

        // just return empty body, too big to stream full response back
        const body = "";
        await cdp.send("Fetch.fulfillRequest", {requestId, responseHeaders: responseHeadersList, responseCode: status, body});
      } catch (e) {
        logger.error("Error in takeStream", {...errJSON(e), url, ...logDetails}, "recorder");
      }
    }

    return takeStreamIter();
  }

  write(chunk) {
    if (!this.fh) {
      this.fh = fs.createWriteStream(this.filename);
    }
    try {
      this.reqresp.readSize += chunk.length;
      this.fh.write(chunk);
    } catch (e) {
      logger.error("Writing Record Buffer Error", e, "recorder");
    }
  }

  async* readAll() {
    if (this.fh) {
      await streamFinish(this.fh);
      this.fh = null;
    } else {
      yield new Uint8Array([]);
      return;
    }

    const url = this.reqresp.url;

    try {
      const reader = fs.createReadStream(this.filename);
      for await (const buff of reader) {
        yield buff;
      }
    } catch (e) {
      logger.error("Error streaming from file", {url, filename: this.filename, ...errJSON(e), ...this.logDetails}, "recorder");
      return;
    }

    try {
      await fsp.unlink(this.filename);
    } catch (e) {
      logger.error("Error closing buffer file", {url, filename: this.filename, ...errJSON(e), ...this.logDetails}, "recorder");
    }
  }
}

// =================================================================
// response
function createResponse(reqresp, pageid, payload) {
  const url = reqresp.url;
  const warcVersion = "WARC/1.1";
  const statusline = `HTTP/1.1 ${reqresp.status} ${reqresp.statusText}`;
  const date = new Date().toISOString();

  const { headersDict } = reqresp.getResponseHeadersDict(reqresp.payload ? reqresp.payload.length : null);
  const httpHeaders = headersDict;

  const warcHeaders = {
    "WARC-Page-ID": pageid,
  };

  const body = payload || [reqresp.payload];

  if (Object.keys(reqresp.extraOpts).length) {
    warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
  }

  return WARCRecord.create({
    url, date, warcVersion, type: "response", warcHeaders,
    httpHeaders, statusline}, body);
}

// =================================================================
// request
function createRequest(reqresp, responseRecord, pageid) {
  const url = reqresp.url;
  const warcVersion = "WARC/1.1";
  const method = reqresp.method;

  const urlParsed = new URL(url);

  const statusline = `${method} ${url.slice(urlParsed.origin.length)} HTTP/1.1`;

  const requestBody = reqresp.postData ? [encoder.encode(reqresp.postData)] : [];

  const { headersDict } = reqresp.getRequestHeadersDict();
  const httpHeaders = headersDict;

  const warcHeaders = {
    "WARC-Concurrent-To": responseRecord.warcHeader("WARC-Record-ID"),
    "WARC-Page-ID": pageid,
  };

  const date = responseRecord.warcDate;

  return WARCRecord.create({
    url, date, warcVersion, type: "request", warcHeaders,
    httpHeaders, statusline}, requestBody);
}

// =================================================================
async function writeRecordPair(fh, responseRecord, requestRecord, logDetails, gzip = true, responseSerializer = null) {
  if (!responseSerializer) {
    responseSerializer = new WARCSerializer(responseRecord, {gzip});
  }

  await writeRecord(fh, responseRecord, responseSerializer, logDetails);
  await writeRecord(fh, requestRecord, new WARCSerializer(requestRecord, {gzip}), logDetails);
}

// =================================================================
async function writeRecord(fh, record, serializer, logDetails) {
  let total = 0;
  let count = 0;
  const url = record.warcTargetURI;

  for await (const chunk of serializer) {
    total += chunk.length;
    count++;
    try {
      fh.write(chunk);
    } catch (e) {
      logger.error("Error writing to WARC, corruption possible", {...errJSON(e), url, logDetails}, "recorder");
    }
    if (!(count % 10)) {
      logNetwork("Writing WARC Chunk", {total, count, url, logDetails});
    }
  }
}

// =================================================================
function streamFinish(fh) {
  const p = new Promise(resolve => {
    fh.once("finish", () => resolve());
  });
  fh.end();
  return p;
}