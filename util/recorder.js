import fsp from "fs/promises";
import path from "path";
import os from "os";

import PQueue from "p-queue";

import { logger, errJSON } from "./logger.js";
import { timestampNow } from "./timing.js";

import { baseRules as baseDSRules } from "@webrecorder/wabac/src/rewrite/index.js";
import { rewriteDASH, rewriteHLS } from "@webrecorder/wabac/src/rewrite/rewriteVideo.js";

import { WARCRecord, WARCSerializer } from "warcio";


// =================================================================
export class Recorder
{
  constructor({workerid, archivesDir, crawlState}) {
    this.workerid = workerid;
    this.crawlState = crawlState;

    this.queue = new PQueue({concurrency: 1});

    this.requestsQ = new PQueue({concurrency: 12});

    this.logDetails = {};

    this.initFH(archivesDir);
  }

  async initFH(archivesDir) {
    await fsp.mkdir(archivesDir, {recursive: true});
    const crawlId = process.env.CRAWL_ID || os.hostname();
    this.fh = await fsp.open(path.join(archivesDir, `rec-${crawlId}-${timestampNow()}-${this.workerid}.warc`), "a");
  }

  async onCreatePage({cdp}) {
    cdp.on("Fetch.requestPaused", (params) => {
      this.requestsQ.add(() => this.continueRequest(params, cdp));
    });

    await cdp.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Response"}]});
  }

  async continueRequest(params, cdp) {
    const { requestId } = params;

    let continued = false;

    try {
      continued = await this.handleRequestPaused(params, cdp);
    } catch (e) {
      logger.error("Error handling response, probably skipping URL", {url: params.request.url, ...errJSON(e), ...this.logDetails}, "recorder");
    }

    if (!continued) {
      try {
        await cdp.send("Fetch.continueResponse", {requestId});
      } catch (e) {
        logger.error("continueResponse failed", {url: params.request.url, ...errJSON(e), ...this.logDetails}, "recorder");
      }
    }
  }

  async handleRequestPaused(params, cdp) {
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

    if (params.responseStatusCode === 204 || (params.responseStatusCode >= 300 && params.responseStatusCode < 400)) {
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

    const extraOpts = {};
    const result = await this.rewriteResponse(params, payload, extraOpts, cdp);
    const changed = result.changed;

    if (!this.fh) {
      logger.debug("No output file, skipping recording", {url, ...this.logDetails}, "recorder");
      return changed;
    }

    payload = result.payload;

    if (await this.isDupeByUrl(url)) {
      logger.debug("URL already encountered, skipping recording", {url, ...this.logDetails}, "recorder");
      return changed;
    }

    const urlParsed = new URL(url);

    const warcVersion = "WARC/1.1";
    const date = new Date().toISOString();

    // response
    const createResponse = () => {
      const statusline = `HTTP/1.1 ${params.responseStatusCode} ${params.responseStatusText}`;

      const httpHeaders = {};
      for (const header of params.responseHeaders) {
        httpHeaders[header.name] = header.value;
      }

      const warcHeaders = {
        "WARC-Page-ID": this.pageid
      };

      return WARCRecord.create({
        url, date, warcVersion, type: "response", warcHeaders,
        httpHeaders, statusline}, [payload]);
    };

    // request
    const createRequest = (responseRecord) => {
      const method = request.method;

      const statusline = `${method} ${url.slice(urlParsed.origin.length)} HTTP/1.1`;
      //const statusline = `${method} ${url} HTTP/1.1`;

      const requestBody = request.postData ? [request.postData] : [];

      const warcHeaders = {
        "WARC-Concurrent-To": responseRecord.warcHeader("WARC-Record-ID"),
        "WARC-Page-ID": this.pageid,
      };

      return WARCRecord.create({
        url, date, warcVersion, type: "request", warcHeaders,
        httpHeaders: request.headers, statusline}, requestBody);
    };

    const responseRecord = await createResponse();
    const requestRecord = await createRequest(responseRecord);

    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(responseRecord, {gzip: true})));
    this.queue.add(async () => await this.fh.writeFile(await WARCSerializer.serialize(requestRecord, {gzip: true})));

    return changed;
  }

  //todo
  async isDupeByUrl(url) {
    return !await this.crawlState.redis.hsetnx("dedup:u", url, "1");
  }

  async onPageStarted({pageid, url}) {
    this.pageid = pageid;
    this.logDetails = {page: url, workerid: this.workerid};
  }

  async onPageFinished() {
    logger.debug("Finishing pending requests for page", {pending: this.requestsQ.pending, ...this.logDetails}, "recorder");
    await this.requestsQ.onIdle();
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
}
