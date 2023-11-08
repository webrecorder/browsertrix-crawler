import fs from "fs";
import path from "path";
import os from "os";

import { v4 as uuidv4 } from "uuid";

import PQueue from "p-queue";

import { logger, errJSON } from "./logger.js";
import { sleep, timestampNow } from "./timing.js";
import { RequestResponseInfo } from "./reqresp.js";

// @ts-expect-error TODO fill in why error is expected
import { baseRules as baseDSRules } from "@webrecorder/wabac/src/rewrite/index.js";
import {
  rewriteDASH,
  rewriteHLS,
  // @ts-expect-error TODO fill in why error is expected
} from "@webrecorder/wabac/src/rewrite/rewriteVideo.js";

import { WARCRecord } from "warcio";
import { TempFileBuffer, WARCSerializer } from "warcio/node";
import { WARCWriter } from "./warcwriter.js";
import { RedisCrawlState, WorkerId } from "./state.js";
import { CDPSession, Protocol } from "puppeteer-core";

const MAX_BROWSER_FETCH_SIZE = 2_000_000;
const MAX_NETWORK_LOAD_SIZE = 200_000_000;

const ASYNC_FETCH_DUPE_KEY = "s:fetchdupe";

const WRITE_DUPE_KEY = "s:writedupe";

const encoder = new TextEncoder();

// =================================================================
// TODO: Fix this the next time the file is edited.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
function logNetwork(msg: string, data: any) {
  // logger.debug(msg, data, "recorderNetwork");
}

// =================================================================
export class Recorder {
  workerid: WorkerId;
  collDir: string;
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crawler: any;

  crawlState: RedisCrawlState;

  warcQ: PQueue;
  fetcherQ: PQueue;

  pendingRequests!: Map<string, RequestResponseInfo>;
  skipIds!: Set<string>;

  swSessionId?: string | null;
  swFrameIds = new Set<string>();
  swUrls = new Set<string>();

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logDetails: Record<string, any> = {};
  skipping = false;

  allowFull206 = false;

  archivesDir: string;
  tempdir: string;
  tempCdxDir: string;

  gzip = true;

  writer: WARCWriter;

  pageid!: string;

  constructor({
    workerid,
    collDir,
    crawler,
  }: {
    workerid: WorkerId;
    collDir: string;
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    crawler: any;
  }) {
    this.workerid = workerid;
    this.crawler = crawler;
    this.crawlState = crawler.crawlState;

    this.warcQ = new PQueue({ concurrency: 1 });

    this.fetcherQ = new PQueue({ concurrency: 1 });

    this.collDir = collDir;

    this.archivesDir = path.join(this.collDir, "archive");
    this.tempdir = path.join(this.collDir, "tmp-dl");
    this.tempCdxDir = path.join(this.collDir, "tmp-cdx");

    fs.mkdirSync(this.tempdir, { recursive: true });
    fs.mkdirSync(this.archivesDir, { recursive: true });
    fs.mkdirSync(this.tempCdxDir, { recursive: true });

    const crawlId = process.env.CRAWL_ID || os.hostname();
    const filename = `rec-${crawlId}-${timestampNow()}-${this.workerid}.warc`;

    this.writer = new WARCWriter({
      archivesDir: this.archivesDir,
      tempCdxDir: this.tempCdxDir,
      filename,
      gzip: this.gzip,
      logDetails: this.logDetails,
    });
  }

  async onCreatePage({ cdp }: { cdp: CDPSession }) {
    // Fetch

    cdp.on("Fetch.requestPaused", async (params) => {
      this.handleRequestPaused(params, cdp);
    });

    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });

    // Response
    cdp.on("Network.responseReceived", (params) => {
      // handling to fill in security details
      logNetwork("Network.responseReceived", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      this.handleResponseReceived(params);
    });

    cdp.on("Network.responseReceivedExtraInfo", (params) => {
      logNetwork("Network.responseReceivedExtraInfo", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      const reqresp = this.pendingReqResp(params.requestId, true);
      if (reqresp) {
        reqresp.fillResponseReceivedExtraInfo(params);
      }
    });

    // Request

    cdp.on("Network.requestWillBeSent", (params) => {
      // only handling redirect here, committing last response in redirect chain
      // request data stored from requestPaused
      if (params.redirectResponse) {
        logNetwork("Network.requestWillBeSent after redirect", {
          requestId: params.requestId,
          ...this.logDetails,
        });
        this.handleRedirectResponse(params);
      }
    });

    cdp.on("Network.requestServedFromCache", (params) => {
      logNetwork("Network.requestServedFromCache", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      this.removeReqResp(params.requestId);
    });

    cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
      logNetwork("Network.requestWillBeSentExtraInfo", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      this.handleRequestExtraInfo(params);
    });

    // Loading
    cdp.on("Network.loadingFinished", (params) => {
      logNetwork("Network.loadingFinished", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      this.handleLoadingFinished(params);
    });

    cdp.on("Network.loadingFailed", (params) => {
      logNetwork("Network.loadingFailed", {
        requestId: params.requestId,
        ...this.logDetails,
      });
      this.handleLoadingFailed(params);
    });

    await cdp.send("Network.enable");

    // Target

    cdp.on("Target.attachedToTarget", async (params) => {
      const { url, type, sessionId } = params.targetInfo;
      if (type === "service_worker") {
        this.swSessionId = sessionId;
        this.swUrls.add(url);
      }
    });

    cdp.on("Target.detachedFromTarget", async (params) => {
      const { sessionId } = params;
      if (this.swSessionId && sessionId === this.swSessionId) {
        this.swUrls.clear();
        this.swFrameIds.clear();
        this.swSessionId = null;
      }
    });

    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  handleResponseReceived(params: Protocol.Network.ResponseReceivedEvent) {
    const { requestId, response } = params;

    const reqresp = this.pendingReqResp(requestId);
    if (!reqresp) {
      return;
    }

    reqresp.fillResponse(response);
  }

  handleRequestExtraInfo(
    params: Protocol.Network.RequestWillBeSentExtraInfoEvent
  ) {
    if (!this.shouldSkip(params.headers)) {
      const reqresp = this.pendingReqResp(params.requestId, true);
      if (reqresp) {
        reqresp.fillRequestExtraInfo(params);
      }
    }
  }

  handleRedirectResponse(params: Protocol.Network.RequestWillBeSentEvent) {
    const { requestId, redirectResponse } = params;

    // remove and serialize, but allow reusing requestId
    // as redirect chain may reuse same requestId for subsequent request
    const reqresp = this.removeReqResp(requestId, true);
    if (!reqresp || !redirectResponse) {
      return;
    }

    reqresp.fillResponse(redirectResponse);

    if (reqresp.isSelfRedirect()) {
      logger.warn(
        "Skipping self redirect",
        { url: reqresp.url, status: reqresp.status, ...this.logDetails },
        "recorder"
      );
      return;
    }

    this.serializeToWARC(reqresp);
  }

  handleLoadingFailed(params: Protocol.Network.LoadingFailedEvent) {
    const { errorText, type, requestId } = params;

    const reqresp = this.pendingReqResp(requestId, true);
    if (!reqresp) {
      return;
    }

    const { url } = reqresp;

    switch (errorText) {
      case "net::ERR_BLOCKED_BY_CLIENT":
        logNetwork("Request blocked", { url, errorText, ...this.logDetails });
        break;

      case "net::ERR_ABORTED":
        // check if this is a false positive -- a valid download that's already been fetched
        // the abort is just for page, but download will succeed
        if (type === "Document" && reqresp.isValidBinary()) {
          this.serializeToWARC(reqresp);
          //} else if (url) {
        } else if (
          url &&
          reqresp.requestHeaders &&
          reqresp.requestHeaders["x-browsertrix-fetch"]
        ) {
          delete reqresp.requestHeaders["x-browsertrix-fetch"];
          logger.warn(
            "Attempt direct fetch of failed request",
            { url, ...this.logDetails },
            "recorder"
          );
          const fetcher = new AsyncFetcher({
            tempdir: this.tempdir,
            reqresp,
            recorder: this,
            networkId: requestId,
          });
          this.fetcherQ.add(() => fetcher.load());
          return;
        }
        break;

      default:
        logger.warn(
          "Request failed",
          { url, errorText, ...this.logDetails },
          "recorder"
        );
    }
    this.removeReqResp(requestId);
  }

  handleLoadingFinished(params: Protocol.Network.LoadingFinishedEvent) {
    const reqresp = this.pendingReqResp(params.requestId, true);

    if (!reqresp || reqresp.asyncLoading) {
      return;
    }

    this.removeReqResp(params.requestId);

    if (!this.isValidUrl(reqresp.url)) {
      return;
    }

    this.serializeToWARC(reqresp);
  }

  async handleRequestPaused(
    params: Protocol.Fetch.RequestPausedEvent,
    cdp: CDPSession,
    isSWorker = false
  ) {
    const {
      requestId,
      request,
      responseStatusCode,
      responseErrorReason,
      resourceType,
      networkId,
    } = params;
    const { method, headers, url } = request;

    logNetwork("Fetch.requestPaused", {
      requestId,
      networkId,
      url,
      ...this.logDetails,
    });

    let continued = false;

    try {
      if (
        responseStatusCode &&
        !responseErrorReason &&
        !this.shouldSkip(headers, url, method, resourceType) &&
        !(isSWorker && networkId)
      ) {
        continued = await this.handleFetchResponse(params, cdp, isSWorker);
      }
    } catch (e) {
      logger.error(
        "Error handling response, probably skipping URL",
        { url, ...errJSON(e), ...this.logDetails },
        "recorder"
      );
    }

    if (!continued) {
      try {
        await cdp.send("Fetch.continueResponse", { requestId });
      } catch (e) {
        logger.debug(
          "continueResponse failed",
          { requestId, networkId, url, ...errJSON(e), ...this.logDetails },
          "recorder"
        );
      }
    }
  }

  async handleFetchResponse(
    params: Protocol.Fetch.RequestPausedEvent,
    cdp: CDPSession,
    isSWorker: boolean
  ) {
    const { request } = params;
    const { url } = request;
    const {
      requestId,
      responseErrorReason,
      responseStatusCode,
      responseHeaders,
    } = params;

    const networkId = params.networkId || requestId;

    if (responseErrorReason) {
      logger.warn(
        "Skipping failed response",
        { url, reason: responseErrorReason, ...this.logDetails },
        "recorder"
      );
      return false;
    }

    const contentLen = this._getContentLen(responseHeaders);

    if (responseStatusCode === 206) {
      const range = this._getContentRange(responseHeaders);
      if (
        this.allowFull206 &&
        range === `bytes 0-${contentLen - 1}/${contentLen}`
      ) {
        logger.debug(
          "Keep 206 Response, Full Range",
          { range, contentLen, url, networkId, ...this.logDetails },
          "recorder"
        );
      } else {
        logger.debug(
          "Skip 206 Response",
          { range, contentLen, url, ...this.logDetails },
          "recorder"
        );
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

      if (isSWorker) {
        this.removeReqResp(networkId);
        await this.serializeToWARC(reqresp);
      }

      return false;
    }

    let streamingConsume = false;

    if (contentLen < 0 || contentLen > MAX_BROWSER_FETCH_SIZE) {
      const opts = {
        tempdir: this.tempdir,
        reqresp,
        expectedSize: contentLen,
        recorder: this,
        networkId,
        cdp,
      };

      // fetching using response stream, await here and then either call fulFill, or if not started, return false
      if (contentLen < 0) {
        const fetcher = new ResponseStreamAsyncFetcher({
          ...opts,
          requestId,
          cdp,
        });
        const res = await fetcher.load();
        switch (res) {
          case "dupe":
            this.removeReqResp(networkId);
            return false;

          case "fetched":
            streamingConsume = true;
            break;
        }
      }

      // if not consumed via takeStream, attempt async loading
      if (!streamingConsume) {
        let fetcher: AsyncFetcher;

        if (reqresp.method !== "GET" || contentLen > MAX_NETWORK_LOAD_SIZE) {
          fetcher = new AsyncFetcher(opts);
        } else {
          fetcher = new NetworkLoadStreamAsyncFetcher(opts);
        }
        this.fetcherQ.add(() => fetcher.load());
        return false;
      }
    } else {
      try {
        logNetwork("Fetching response", {
          sizeExpected: this._getContentLen(responseHeaders),
          url,
          networkId,
          ...this.logDetails,
        });
        const { body, base64Encoded } = await cdp.send(
          "Fetch.getResponseBody",
          { requestId }
        );
        reqresp.payload = Buffer.from(body, base64Encoded ? "base64" : "utf-8");
        logNetwork("Fetch done", {
          size: reqresp.payload.length,
          url,
          networkId,
          ...this.logDetails,
        });
      } catch (e) {
        logger.warn(
          "Failed to load response body",
          { url, networkId, ...errJSON(e), ...this.logDetails },
          "recorder"
        );
        return false;
      }
    }

    const rewritten = await this.rewriteResponse(reqresp);

    // if in service worker, serialize here
    // as won't be getting a loadingFinished message
    if (isSWorker && reqresp.payload) {
      this.removeReqResp(networkId);
      await this.serializeToWARC(reqresp);
    }

    // not rewritten, and not streaming, return false to continue
    if (!rewritten && !streamingConsume) {
      if (!reqresp.payload) {
        logger.error(
          "Unable to get payload skipping recording",
          { url, ...this.logDetails },
          "recorder"
        );
        this.removeReqResp(networkId);
      }
      return false;
    }

    // if has payload, encode it, otherwise return empty string
    const body =
      reqresp.payload && reqresp.payload.length
        ? Buffer.from(reqresp.payload).toString("base64")
        : "";

    try {
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode || 0,
        responseHeaders,
        body,
      });
    } catch (e) {
      const type = reqresp.resourceType;
      if (type === "Document") {
        logger.debug(
          "document not loaded in browser, possibly other URLs missing",
          { url, type: reqresp.resourceType },
          "recorder"
        );
      } else {
        logger.debug(
          "URL not loaded in browser",
          { url, type: reqresp.resourceType },
          "recorder"
        );
      }
    }

    return true;
  }

  startPage({ pageid, url }: { pageid: string; url: string }) {
    this.pageid = pageid;
    this.logDetails = { page: url, workerid: this.workerid };
    if (this.pendingRequests && this.pendingRequests.size) {
      logger.debug(
        "Interrupting timed out requests, moving to next page",
        this.logDetails,
        "recorder"
      );
    }
    this.pendingRequests = new Map();
    this.skipIds = new Set();
    this.skipping = false;
  }

  async finishPage() {
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
        const url = reqresp.url || "";
        const entry: {
          requestId: string;
          url: string;
          expectedSize?: number;
          readSize?: number;
        } = { requestId, url };
        if (reqresp.expectedSize) {
          entry.expectedSize = reqresp.expectedSize;
        }
        if (reqresp.readSize) {
          entry.readSize = reqresp.readSize;
        }
        pending.push(entry);
      }

      logger.debug(
        "Finishing pending requests for page",
        { numPending, pending, ...this.logDetails },
        "recorder"
      );
      await sleep(5.0);
      numPending = this.pendingRequests.size;
    }
  }

  async onClosePage() {
    // Any page-specific handling before page is closed.
  }

  async onDone() {
    await this.crawlState.setStatus("pending-wait");

    logger.debug("Finishing Fetcher Queue", this.logDetails, "recorder");
    await this.fetcherQ.onIdle();

    logger.debug("Finishing WARC writing", this.logDetails, "recorder");
    await this.warcQ.onIdle();

    await this.writer.flush();
  }

  shouldSkip(
    headers: Protocol.Network.Headers,
    url?: string,
    method?: string,
    resourceType?: string
  ) {
    if (headers && !method) {
      method = headers[":method"];
    }

    if (!this.isValidUrl(url)) {
      return true;
    }

    if (method === "OPTIONS" || method === "HEAD") {
      return true;
    }

    if (["EventSource", "WebSocket", "Ping"].includes(resourceType || "")) {
      return true;
    }

    // beacon
    if (resourceType === "Other" && method === "POST") {
      return true;
    }

    // skip eventsource, resourceType may not be set correctly
    if (
      headers &&
      (headers["accept"] === "text/event-stream" ||
        headers["Accept"] === "text/event-stream")
    ) {
      return true;
    }

    return false;
  }

  async rewriteResponse(reqresp: RequestResponseInfo) {
    const { url, responseHeadersList, extraOpts, payload } = reqresp;

    if (!payload || !payload.length) {
      return false;
    }

    let newString = null;
    let string = null;

    const ct = this._getContentType(responseHeadersList);

    switch (ct) {
      case "application/x-mpegURL":
      case "application/vnd.apple.mpegurl":
        string = payload.toString();
        newString = rewriteHLS(string, { save: extraOpts });
        break;

      case "application/dash+xml":
        string = payload.toString();
        newString = rewriteDASH(string, { save: extraOpts });
        break;

      case "text/html":
      case "application/json":
      case "text/javascript":
      case "application/javascript":
      case "application/x-javascript": {
        const rw = baseDSRules.getRewriter(url);

        if (rw !== baseDSRules.defaultRewriter) {
          string = payload.toString();
          newString = rw.rewrite(string, { live: true, save: extraOpts });
        }
        break;
      }
    }

    if (!newString) {
      return false;
    }

    if (newString !== string) {
      extraOpts.rewritten = 1;
      logger.debug(
        "Content Rewritten",
        { url, ...this.logDetails },
        "recorder"
      );
      reqresp.payload = encoder.encode(newString);
      return true;
    } else {
      return false;
    }

    //return Buffer.from(newString).toString("base64");
  }

  _getContentType(
    headers?: Protocol.Fetch.HeaderEntry[] | { name: string; value: string }[]
  ) {
    if (!headers) {
      return null;
    }
    for (const header of headers) {
      if (header.name.toLowerCase() === "content-type") {
        return header.value.split(";")[0];
      }
    }

    return null;
  }

  _getContentLen(headers?: Protocol.Fetch.HeaderEntry[]) {
    if (!headers) {
      return -1;
    }
    for (const header of headers) {
      if (header.name.toLowerCase() === "content-length") {
        return Number(header.value);
      }
    }

    return -1;
  }

  _getContentRange(headers?: Protocol.Fetch.HeaderEntry[]) {
    if (!headers) {
      return null;
    }
    for (const header of headers) {
      if (header.name.toLowerCase() === "content-range") {
        return header.value;
      }
    }

    return null;
  }

  noResponseForStatus(status: number | undefined | null) {
    return !status || status === 204 || (status >= 300 && status < 400);
  }

  isValidUrl(url?: string) {
    return url && (url.startsWith("https:") || url.startsWith("http:"));
  }

  pendingReqResp(requestId: string, reuseOnly = false) {
    if (!this.pendingRequests.has(requestId)) {
      if (reuseOnly || !requestId) {
        return null;
      }
      if (this.skipIds.has(requestId)) {
        logNetwork("Skipping ignored id", { requestId });
        return null;
      }
      if (this.skipping) {
        //logger.debug("Skipping request, page already finished", this.logDetails, "recorder");
        return null;
      }
      const reqresp = new RequestResponseInfo(requestId);
      this.pendingRequests.set(requestId, reqresp);
      return reqresp;
    } else {
      const reqresp = this.pendingRequests.get(requestId);
      if (reqresp && requestId !== reqresp.requestId) {
        logger.warn(
          "Invalid request id",
          { requestId, actualRequestId: reqresp.requestId },
          "recorder"
        );
      }
      return reqresp;
    }
  }

  removeReqResp(requestId: string, allowReuse = false) {
    const reqresp = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    if (!allowReuse) {
      this.skipIds.add(requestId);
    }
    return reqresp;
  }

  async serializeToWARC(reqresp: RequestResponseInfo) {
    if (!reqresp.payload) {
      logNetwork("Not writing, no payload", { url: reqresp.url });
      return;
    }

    if (
      reqresp.url &&
      reqresp.method === "GET" &&
      !(await this.crawlState.addIfNoDupe(WRITE_DUPE_KEY, reqresp.url))
    ) {
      logNetwork("Skipping dupe", { url: reqresp.url });
      return;
    }

    const responseRecord = createResponse(reqresp, this.pageid);
    const requestRecord = createRequest(reqresp, responseRecord, this.pageid);

    this.warcQ.add(() =>
      this.writer.writeRecordPair(responseRecord, requestRecord)
    );
  }

  async directFetchCapture(
    url: string
  ): Promise<{ fetched: boolean; mime: string }> {
    const reqresp = new RequestResponseInfo("0");
    reqresp.url = url;
    reqresp.method = "GET";

    logger.debug(
      "Directly fetching page URL without browser",
      { url, ...this.logDetails },
      "recorder"
    );

    const filter = (resp: Response) =>
      resp.status === 200 && !resp.headers.get("set-cookie");

    // ignore dupes: if previous URL was not a page, still load as page. if previous was page,
    // should not get here, as dupe pages tracked via seen list
    const fetcher = new AsyncFetcher({
      tempdir: this.tempdir,
      reqresp,
      recorder: this,
      networkId: "0",
      filter,
      ignoreDupe: true,
    });
    const res = await fetcher.load();

    const mime =
      (reqresp &&
        reqresp.responseHeaders &&
        reqresp.responseHeaders["content-type"] &&
        reqresp.responseHeaders["content-type"].split(";")[0]) ||
      "";

    return { fetched: res === "fetched", mime };
  }
}

// =================================================================
class AsyncFetcher {
  reqresp: RequestResponseInfo;

  networkId: string;
  filter?: (resp: Response) => boolean;
  ignoreDupe = false;

  recorder: Recorder;

  tempdir: string;
  filename: string;

  constructor({
    tempdir,
    reqresp,
    expectedSize = -1,
    recorder,
    networkId,
    filter = undefined,
    ignoreDupe = false,
  }: {
    tempdir: string;
    reqresp: RequestResponseInfo;
    expectedSize?: number;
    recorder: Recorder;
    networkId: string;
    filter?: (resp: Response) => boolean;
    ignoreDupe?: boolean;
  }) {
    this.reqresp = reqresp;
    this.reqresp.expectedSize = expectedSize;
    this.reqresp.asyncLoading = true;

    this.networkId = networkId;
    this.filter = filter;
    this.ignoreDupe = ignoreDupe;

    this.recorder = recorder;

    this.tempdir = tempdir;
    this.filename = path.join(
      this.tempdir,
      `${timestampNow()}-${uuidv4()}.data`
    );
  }

  async load() {
    const { reqresp, recorder, networkId, filename } = this;
    const { url } = reqresp;

    const { pageid, crawlState, gzip, logDetails } = recorder;

    let fetched = "notfetched";

    try {
      if (
        reqresp.method === "GET" &&
        url &&
        !(await crawlState.addIfNoDupe(ASYNC_FETCH_DUPE_KEY, url))
      ) {
        if (!this.ignoreDupe) {
          this.reqresp.asyncLoading = false;
          return "dupe";
        }
      }

      const body = await this._doFetch();
      fetched = "fetched";

      const responseRecord = createResponse(reqresp, pageid, body);
      const requestRecord = createRequest(reqresp, responseRecord, pageid);

      const serializer = new WARCSerializer(responseRecord, {
        gzip,
        maxMemSize: MAX_BROWSER_FETCH_SIZE,
      });

      try {
        let readSize = await serializer.digestRecord();
        if (serializer.httpHeadersBuff) {
          readSize -= serializer.httpHeadersBuff.length;
        }
        reqresp.readSize = readSize;
      } catch (e) {
        logger.error(
          "Error reading + digesting payload",
          { url, filename, ...errJSON(e), ...logDetails },
          "recorder"
        );
      }

      if (
        reqresp.readSize === reqresp.expectedSize ||
        reqresp.expectedSize < 0
      ) {
        logger.debug(
          "Async fetch: streaming done",
          {
            size: reqresp.readSize,
            expected: reqresp.expectedSize,
            networkId,
            url,
            ...logDetails,
          },
          "recorder"
        );
      } else {
        logger.warn(
          "Async fetch: possible response size mismatch",
          {
            size: reqresp.readSize,
            expected: reqresp.expectedSize,
            url,
            ...logDetails,
          },
          "recorder"
        );
        //await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url);
        //return fetched;
      }

      const externalBuffer: TempFileBuffer =
        serializer.externalBuffer as TempFileBuffer;

      if (externalBuffer) {
        const { currSize, buffers, fh } = externalBuffer;

        if (buffers && buffers.length && !fh) {
          reqresp.payload = Buffer.concat(buffers, currSize);
          externalBuffer.buffers = [reqresp.payload];
        }
      }

      if (Object.keys(reqresp.extraOpts).length) {
        responseRecord.warcHeaders.headers.set(
          "WARC-JSON-Metadata",
          JSON.stringify(reqresp.extraOpts)
        );
      }

      recorder.warcQ.add(() =>
        recorder.writer.writeRecordPair(
          responseRecord,
          requestRecord,
          serializer
        )
      );
    } catch (e) {
      logger.error(
        "Streaming Fetch Error",
        { url, networkId, filename, ...errJSON(e), ...logDetails },
        "recorder"
      );
      await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url!);
    } finally {
      recorder.removeReqResp(networkId);
    }

    return fetched;
  }

  async _doFetch() {
    const { reqresp } = this;
    const { method, url } = reqresp;
    logger.debug("Async started: fetch", { url }, "recorder");

    const headers = reqresp.getRequestHeadersDict();

    let signal = null;
    let abort = null;

    if (this.filter) {
      abort = new AbortController();
      signal = abort.signal;
    }

    const resp = await fetch(url!, {
      method,
      headers,
      body: reqresp.postData || undefined,
      signal,
    });

    if (this.filter && !this.filter(resp) && abort) {
      abort.abort();
      throw new Error("invalid response, ignoring fetch");
    }

    if (
      reqresp.expectedSize < 0 &&
      resp.headers.get("content-length") &&
      !resp.headers.get("content-encoding")
    ) {
      reqresp.expectedSize = Number(resp.headers.get("content-length") || -1);
    }

    if (reqresp.expectedSize === 0) {
      reqresp.payload = new Uint8Array();
      return;
    } else if (!resp.body) {
      logger.error("Empty body, stopping fetch", { url }, "recorder");
      await this.recorder.crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url!);
      return;
    }

    reqresp.fillFetchResponse(resp);

    return this.takeReader(resp.body.getReader());
  }

  async *takeReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        yield value;
      }
    } catch (e) {
      logger.warn(
        "takeReader interrupted",
        { ...errJSON(e), url: this.reqresp.url, ...this.recorder.logDetails },
        "recorder"
      );
      this.reqresp.truncated = "disconnect";
    }
  }

  async *takeStreamIter(cdp: CDPSession, stream: Protocol.IO.StreamHandle) {
    try {
      while (true) {
        const { data, base64Encoded, eof } = await cdp.send("IO.read", {
          handle: stream,
        });
        const buff = Buffer.from(data, base64Encoded ? "base64" : "utf-8");

        yield buff;

        if (eof) {
          break;
        }
      }
    } catch (e) {
      logger.warn(
        "takeStream interrupted",
        { ...errJSON(e), url: this.reqresp.url, ...this.recorder.logDetails },
        "recorder"
      );
      this.reqresp.truncated = "disconnect";
    }
  }
}

// =================================================================
class ResponseStreamAsyncFetcher extends AsyncFetcher {
  cdp: CDPSession;
  requestId: string;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(opts: any) {
    super(opts);
    this.cdp = opts.cdp;
    this.requestId = opts.requestId;
  }

  async _doFetch() {
    const { requestId, reqresp, cdp } = this;
    const { url } = reqresp;
    logger.debug("Async started: takeStream", { url }, "recorder");

    const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
      requestId,
    });

    return this.takeStreamIter(cdp, stream);
  }
}

// =================================================================
class NetworkLoadStreamAsyncFetcher extends AsyncFetcher {
  cdp: CDPSession;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(opts: any) {
    super(opts);
    this.cdp = opts.cdp;
  }

  async _doFetch() {
    const { reqresp, cdp } = this;
    const { url } = reqresp;
    logger.debug("Async started: loadNetworkResource", { url }, "recorder");

    const options = { disableCache: false, includeCredentials: true };

    let result = null;

    try {
      result = await cdp.send("Network.loadNetworkResource", {
        frameId: reqresp.frameId,
        url,
        options,
      });
    } catch (e) {
      logger.debug(
        "Network.loadNetworkResource failed, attempting node fetch",
        { url, ...errJSON(e), ...this.recorder.logDetails },
        "recorder"
      );
      return await super._doFetch();
    }

    const { stream, headers, httpStatusCode, success, netError, netErrorName } =
      result.resource;

    if (!success || !stream) {
      //await this.recorder.crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url);
      logger.debug(
        "Network.loadNetworkResource failed, attempting node fetch",
        {
          url,
          netErrorName,
          netError,
          httpStatusCode,
          ...this.recorder.logDetails,
        },
        "recorder"
      );
      return await super._doFetch();
    }

    if (
      reqresp.expectedSize < 0 &&
      headers &&
      headers["content-length"] &&
      !headers["content-encoding"]
    ) {
      reqresp.expectedSize = Number(headers["content-length"] || -1);
    }

    if (reqresp.expectedSize === 0) {
      reqresp.payload = new Uint8Array();
      return;
    }

    reqresp.status = httpStatusCode || 0;
    reqresp.responseHeaders = headers || {};

    return this.takeStreamIter(cdp, stream);
  }
}

// =================================================================
// response
function createResponse(
  reqresp: RequestResponseInfo,
  pageid: string,
  contentIter?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
) {
  const url = reqresp.url;
  const warcVersion = "WARC/1.1";
  const statusline = `HTTP/1.1 ${reqresp.status} ${reqresp.statusText}`;
  const date = new Date().toISOString();

  const httpHeaders = reqresp.getResponseHeadersDict(
    reqresp.payload ? reqresp.payload.length : 0
  );

  const warcHeaders: Record<string, string> = {
    "WARC-Page-ID": pageid,
  };

  if (reqresp.truncated) {
    warcHeaders["WARC-Truncated"] = reqresp.truncated;
  }

  if (!contentIter) {
    contentIter = [reqresp.payload] as Iterable<Uint8Array>;
  }

  if (Object.keys(reqresp.extraOpts).length) {
    warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
  }

  return WARCRecord.create(
    {
      url,
      date,
      warcVersion,
      type: "response",
      warcHeaders,
      httpHeaders,
      statusline,
    },
    contentIter
  );
}

// =================================================================
// request
function createRequest(
  reqresp: RequestResponseInfo,
  responseRecord: WARCRecord,
  pageid: string
) {
  const url = reqresp.url;
  const warcVersion = "WARC/1.1";
  const method = reqresp.method;

  const urlParsed = new URL(url);

  const statusline = `${method} ${url.slice(urlParsed.origin.length)} HTTP/1.1`;

  const requestBody = reqresp.postData
    ? [encoder.encode(reqresp.postData)]
    : [];

  const httpHeaders = reqresp.getRequestHeadersDict();

  const warcHeaders: Record<string, string> = {
    "WARC-Concurrent-To": responseRecord.warcHeader("WARC-Record-ID")!,
    "WARC-Page-ID": pageid,
  };

  const date = responseRecord.warcDate || undefined;

  return WARCRecord.create(
    {
      url,
      date,
      warcVersion,
      type: "request",
      warcHeaders,
      httpHeaders,
      statusline,
    },
    requestBody
  );
}
