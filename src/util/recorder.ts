import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import {
  RequestResponseInfo,
  isHTMLMime,
  isRedirectStatus,
} from "./reqresp.js";

import { fetch, Response } from "undici";

import {
  getCustomRewriter,
  removeRangeAsQuery,
  rewriteDASH,
  rewriteHLS,
} from "@webrecorder/wabac";

import { WARCRecord } from "warcio";
import { TempFileBuffer, WARCSerializer } from "warcio/node";
import { WARCWriter } from "./warcwriter.js";
import { RedisCrawlState, WorkerId } from "./state.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { Crawler } from "../crawler.js";
import { getProxyDispatcher } from "./proxy.js";
import { ScopedSeed } from "./seeds.js";
import EventEmitter from "events";

const MAX_BROWSER_DEFAULT_FETCH_SIZE = 5_000_000;
const MAX_TEXT_REWRITE_SIZE = 25_000_000;

const MAX_NETWORK_LOAD_SIZE = 200_000_000;

const TAKE_STREAM_BUFF_SIZE = 1024 * 64;

const ASYNC_FETCH_DUPE_KEY = "s:fetchdupe";

const WRITE_DUPE_KEY = "s:writedupe";

const MIME_EVENT_STREAM = "text/event-stream";

const RW_MIME_TYPES = [
  "application/x-mpegURL",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
  "text/html",
  "application/json",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
];

const encoder = new TextEncoder();

// =================================================================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logNetwork(msg: string, data: any) {
  logger.debug(msg, data, "recorderNetwork");
}

// =================================================================
export type PageInfoValue = {
  status: number;
  mime?: string;
  type?: string;
  error?: string;
  fromBrowserCache?: boolean;
};

// =================================================================
export type PageInfoRecord = {
  pageid: string;
  urls: Record<string, PageInfoValue>;
  url: string;
  ts?: Date;
  tsStatus: number;
  counts: {
    jsErrors: number;
  };
};

// =================================================================
export type AsyncFetchOptions = {
  reqresp: RequestResponseInfo;
  expectedSize?: number;
  // eslint-disable-next-line no-use-before-define
  recorder: Recorder;
  networkId: string;
  filter?: (resp: Response) => boolean;
  ignoreDupe?: boolean;
  maxFetchSize?: number;
  manualRedirect?: boolean;
};

// =================================================================
export type DirectFetchRequest = {
  url: string;
  headers: Record<string, string>;
  cdp: CDPSession;
};

// =================================================================
export type DirectFetchResponse = {
  fetched: boolean;
  mime: string;
  ts: Date;
};

// =================================================================
export type NetworkLoadAsyncFetchOptions = AsyncFetchOptions & {
  cdp: CDPSession;
};

// =================================================================
export type ResponseStreamAsyncFetchOptions = NetworkLoadAsyncFetchOptions & {
  requestId: string;
};

// =================================================================
export class Recorder extends EventEmitter {
  workerid: WorkerId;

  crawler: Crawler;

  crawlState: RedisCrawlState;

  fetcherQ: PQueue;

  pendingRequests!: Map<string, RequestResponseInfo>;
  skipIds!: Set<string>;
  pageInfo!: PageInfoRecord;
  mainFrameId: string | null = null;
  skipRangeUrls!: Map<string, number>;

  swTargetId?: string | null;
  swFrameIds = new Set<string>();
  swUrls = new Set<string>();

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logDetails: Record<string, any> = {};

  pageFinished = false;

  gzip = true;

  writer: WARCWriter;

  pageUrl!: string;
  pageid!: string;

  pageSeed?: ScopedSeed;

  frameIdToExecId: Map<string, number> | null;

  constructor({
    workerid,
    writer,
    crawler,
  }: {
    workerid: WorkerId;
    writer: WARCWriter;
    crawler: Crawler;
  }) {
    super();
    this.workerid = workerid;
    this.crawler = crawler;
    this.crawlState = crawler.crawlState;

    this.writer = writer;

    this.fetcherQ = new PQueue({ concurrency: 1 });

    this.frameIdToExecId = null;
  }

  async onCreatePage({
    cdp,
    frameIdToExecId,
  }: {
    cdp: CDPSession;
    frameIdToExecId: Map<string, number>;
  }) {
    this.frameIdToExecId = frameIdToExecId;
    this.pageFinished = false;

    // Fetch
    cdp.on("Fetch.requestPaused", (params) => {
      void this.handleRequestPaused(params, cdp);
    });

    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });

    // Response
    cdp.on("Network.responseReceived", (params) =>
      this.handleResponseReceived(params),
    );

    cdp.on("Network.responseReceivedExtraInfo", (params) =>
      this.handleResponseReceivedExtraInfo(params),
    );

    // Cache
    cdp.on("Network.requestServedFromCache", (params) =>
      this.handleRequestServedFromCache(params),
    );

    // Request
    cdp.on("Network.requestWillBeSent", (params) =>
      this.handleRequestWillBeSent(params),
    );

    cdp.on("Network.requestWillBeSentExtraInfo", (params) =>
      this.handleRequestExtraInfo(params),
    );

    // Loading
    cdp.on("Network.loadingFinished", (params) =>
      this.handleLoadingFinished(params),
    );

    cdp.on("Network.loadingFailed", (params) =>
      this.handleLoadingFailed(params),
    );

    await cdp.send("Network.enable");

    // Target
    cdp.on("Target.attachedToTarget", async (params) => {
      const { url, type, targetId } = params.targetInfo;
      if (type === "service_worker") {
        this.swTargetId = targetId;
        this.swUrls.add(url);
      }
    });

    cdp.on("Target.detachedFromTarget", async (params) => {
      const { targetId } = params;
      if (this.swTargetId && targetId === this.swTargetId) {
        this.swUrls.clear();
        this.swFrameIds.clear();
        this.swTargetId = null;
      }
    });

    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    // Console
    cdp.on("Console.messageAdded", (params) => {
      const { message } = params;
      const { source, level } = message;
      if (source === "console-api" && level === "error") {
        this.pageInfo.counts.jsErrors++;
      }
    });

    await cdp.send("Console.enable");
  }

  hasFrame(frameId: string) {
    return this.swFrameIds.has(frameId) || this.frameIdToExecId?.has(frameId);
  }

  handleResponseReceived(params: Protocol.Network.ResponseReceivedEvent) {
    const { requestId, response, type } = params;

    const { mimeType, url, headers } = response;

    logNetwork("Network.responseReceived", {
      requestId,
      url,
      ...this.logDetails,
    });

    if (mimeType === MIME_EVENT_STREAM) {
      return;
    }

    if (this.shouldSkip(headers, url, undefined, type)) {
      return;
    }

    const reqresp = this.pendingReqResp(requestId);
    if (!reqresp) {
      return;
    }

    reqresp.fillResponse(response, type);
  }

  handleResponseReceivedExtraInfo(
    params: Protocol.Network.ResponseReceivedExtraInfoEvent,
  ) {
    const { requestId } = params;

    logNetwork("Network.responseReceivedExtraInfo", {
      requestId,
      ...this.logDetails,
    });

    const reqresp = this.pendingReqResp(requestId, true);
    if (reqresp) {
      reqresp.fillResponseReceivedExtraInfo(params);
    }
  }

  handleRequestServedFromCache(
    params: Protocol.Network.RequestServedFromCacheEvent,
  ) {
    const { requestId } = params;

    const reqresp = this.pendingReqResp(requestId, true);

    const url = reqresp?.url;

    logNetwork("Network.requestServedFromCache", {
      requestId,
      url,
      ...this.logDetails,
    });

    if (reqresp) {
      reqresp.fromCache = true;
    }
  }

  handleRequestWillBeSent(params: Protocol.Network.RequestWillBeSentEvent) {
    const { redirectResponse, requestId, request, type } = params;

    const { headers, method, url } = request;

    logNetwork("Network.requestWillBeSent", {
      requestId,
      url,
      redirectResponse,
      ...this.logDetails,
    });

    // handling redirect here, committing last response in redirect chain
    // request data stored from requestPaused
    if (redirectResponse) {
      this.handleRedirectResponse(params);
    } else {
      if (!this.shouldSkip(headers, url, method, type)) {
        const reqresp = this.pendingReqResp(requestId);
        if (reqresp) {
          reqresp.fillRequest(request, type || "");
        }
      }
    }
  }

  handleRequestExtraInfo(
    params: Protocol.Network.RequestWillBeSentExtraInfoEvent,
  ) {
    const { requestId, headers } = params;

    logNetwork("Network.requestWillBeSentExtraInfo", {
      requestId,
      ...this.logDetails,
    });

    if (!this.shouldSkip(headers)) {
      const reqresp = this.pendingReqResp(requestId, true);
      if (reqresp) {
        reqresp.fillRequestExtraInfo(params);
      }
    }
  }

  handleRedirectResponse(params: Protocol.Network.RequestWillBeSentEvent) {
    const { requestId, redirectResponse, type } = params;

    // remove and serialize, but allow reusing requestId
    // as redirect chain may reuse same requestId for subsequent request
    const reqresp = this.removeReqResp(requestId, true);
    if (!reqresp || !redirectResponse) {
      return;
    }

    reqresp.fillResponse(redirectResponse, type);

    if (reqresp.isSelfRedirect()) {
      logger.warn(
        "Skipping self redirect",
        { url: reqresp.url, status: reqresp.status, ...this.logDetails },
        "recorder",
      );
      return;
    }

    try {
      new URL(reqresp.url);
    } catch (e) {
      logger.warn(
        "Skipping invalid URL from redirect",
        { url: reqresp.url, status: reqresp.status, ...this.logDetails },
        "recorder",
      );
      return;
    }

    this.serializeToWARC(reqresp).catch((e) =>
      logger.warn("Error Serializing to WARC", e, "recorder"),
    );
  }

  handleLoadingFailed(params: Protocol.Network.LoadingFailedEvent) {
    const { errorText, type, requestId } = params;

    const reqresp = this.pendingReqResp(requestId, true);

    const url = reqresp?.url;

    logNetwork("Network.loadingFailed", {
      requestId,
      url,
      errorText,
      type,
      ...this.logDetails,
    });

    if (!reqresp) {
      return;
    }

    if (type) {
      reqresp.resourceType = type.toLowerCase();
    }

    switch (errorText) {
      case "net::ERR_BLOCKED_BY_CLIENT":
        logNetwork("Request blocked", { url, errorText, ...this.logDetails });
        break;

      case "net::ERR_ABORTED":
        // check if this is a false positive -- a valid download that's already been fetched
        // the abort is just for page, but download will succeed
        if (
          (type === "Document" || type === "Media") &&
          reqresp.isValidBinary()
        ) {
          this.removeReqResp(requestId);
          return this.serializeToWARC(reqresp);
        } else if (url && reqresp.requestHeaders && type === "Media") {
          this.removeReqResp(requestId);
          logger.warn(
            "Attempt direct fetch of failed request",
            { url, ...this.logDetails },
            "recorder",
          );
          reqresp.deleteRange();
          reqresp.requestId = "0";

          const fetcher = new AsyncFetcher({
            reqresp,
            expectedSize: reqresp.expectedSize ? reqresp.expectedSize : -1,
            recorder: this,
            networkId: "0",
          });
          void this.fetcherQ.add(() => fetcher.load());
          return;
        }
        break;

      default:
        logger.warn(
          "Request failed",
          { url, errorText, type, status: reqresp.status, ...this.logDetails },
          "recorder",
        );
    }
    reqresp.status = 0;
    reqresp.errorText = errorText;
    this.addPageRecord(reqresp);

    this.removeReqResp(requestId);
  }

  handleLoadingFinished(params: Protocol.Network.LoadingFinishedEvent) {
    const { requestId } = params;

    const reqresp = this.pendingReqResp(requestId, true);

    const url = reqresp?.url;

    logNetwork("Network.loadingFinished", {
      requestId,
      url,
      ...this.logDetails,
    });

    if (!reqresp || reqresp.asyncLoading) {
      return;
    }

    this.removeReqResp(requestId);

    if (!this.isValidUrl(url)) {
      return;
    }

    this.serializeToWARC(reqresp).catch((e) =>
      logger.warn("Error Serializing to WARC", e, "recorder"),
    );
  }

  async handleRequestPaused(
    params: Protocol.Fetch.RequestPausedEvent,
    cdp: CDPSession,
    isBrowserContext = false,
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
        !this.shouldSkip(headers, url, method, resourceType)
      ) {
        this.emit("fetching", { url });
        continued = await this.handleFetchResponse(
          params,
          cdp,
          isBrowserContext,
        );
      }
    } catch (e) {
      logger.error(
        "Error handling response, probably skipping URL",
        { url, ...formatErr(e), ...this.logDetails },
        "recorder",
      );
    }

    if (!continued) {
      try {
        await cdp.send("Fetch.continueResponse", { requestId });
      } catch (e) {
        logger.debug(
          "continueResponse failed",
          { requestId, networkId, url, ...formatErr(e), ...this.logDetails },
          "recorder",
        );
      }
    }
  }

  async handleFetchResponse(
    params: Protocol.Fetch.RequestPausedEvent,
    cdp: CDPSession,
    isBrowserContext: boolean,
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

    const reqresp = this.pendingReqResp(networkId);

    if (!reqresp) {
      return false;
    }

    if (responseErrorReason) {
      logger.warn(
        "Skipping failed response",
        { url, reason: responseErrorReason, ...this.logDetails },
        "recorder",
      );
      return false;
    }

    const contentLen = this._getContentLen(responseHeaders);

    if (responseStatusCode === 206) {
      const range = this._getContentRange(responseHeaders);
      if (range === `bytes 0-${contentLen - 1}/${contentLen}`) {
        logger.debug(
          "Keep 206 Response, Full Range",
          { range, contentLen, url, networkId, ...this.logDetails },
          "recorder",
        );
      } else if (range?.startsWith("bytes 0-")) {
        logger.debug(
          "Re-request 206 Response without range",
          { range, contentLen, url, ...this.logDetails },
          "recorder",
        );
        this.removeReqResp(networkId);

        if (!reqresp.fetchContinued) {
          const reqrespNew = new RequestResponseInfo("0");
          reqrespNew.fillRequest(params.request, params.resourceType);
          reqrespNew.deleteRange();
          reqrespNew.frameId = params.frameId;

          this.addAsyncFetch(
            {
              reqresp: reqrespNew,
              expectedSize: parseInt(range.split("/")[1]),
              recorder: this,
              networkId: "0",
              cdp,
            },
            contentLen,
          );
        }

        return false;
      } else {
        // logger.debug(
        //   "Skip 206 Response",
        //   { range, contentLen, url, ...this.logDetails },
        //   "recorder",
        // );
        this.removeReqResp(networkId);
        const count = this.skipRangeUrls.get(url) || 0;
        if (count > 2) {
          // just fail additional range requests to save bandwidth, as these are not being recorded
          await cdp.send("Fetch.failRequest", {
            requestId,
            errorReason: "BlockedByResponse",
          });
          return true;
        }
        this.skipRangeUrls.set(url, count + 1);
        return false;
      }
    } else {
      const filteredUrl = removeRangeAsQuery(url);
      if (filteredUrl) {
        this.removeReqResp(networkId);

        logger.debug(
          "Removed range in query, async fetching full URL",
          { url, ...this.logDetails },
          "recorder",
        );

        if (!reqresp.fetchContinued) {
          const reqrespNew = new RequestResponseInfo("0");
          reqrespNew.fillRequest(params.request, params.resourceType);
          reqrespNew.url = filteredUrl;
          reqrespNew.frameId = params.frameId;

          this.addAsyncFetch({
            reqresp: reqrespNew,
            recorder: this,
            networkId: "0",
            cdp,
          });
        }
        return false;
      }
    }

    // indicate that this is intercepted in the page context
    if (!isBrowserContext) {
      reqresp.inPageContext = true;
    }

    // Already being handled by a different handler
    if (reqresp.fetchContinued) {
      return false;
    }

    reqresp.fetchContinued = true;

    reqresp.fillFetchRequestPaused(params);

    if (
      url === this.pageUrl &&
      (!this.pageInfo.ts ||
        (responseStatusCode && responseStatusCode <= this.pageInfo.tsStatus))
    ) {
      const errorReason = await this.blockPageResponse(
        url,
        reqresp,
        responseHeaders,
      );

      if (errorReason) {
        await cdp.send("Fetch.failRequest", {
          requestId,
          errorReason,
        });
        return true;
      }

      logger.debug("Setting page timestamp", {
        ts: reqresp.ts,
        url,
        status: responseStatusCode,
      });
      this.pageInfo.ts = reqresp.ts;
      this.pageInfo.tsStatus = responseStatusCode!;
      this.mainFrameId = params.frameId;
    }

    if (this.noResponseForStatus(responseStatusCode)) {
      reqresp.payload = new Uint8Array();
      return false;
    }

    const mimeType = this.getMimeType(responseHeaders) || "";

    let streamingConsume = false;

    if (
      this.shouldStream(
        contentLen,
        responseStatusCode || 0,
        reqresp.resourceType || "",
        mimeType,
      )
    ) {
      const opts: ResponseStreamAsyncFetchOptions = {
        reqresp,
        expectedSize: contentLen,
        recorder: this,
        networkId,
        cdp,
        requestId,
      };

      // fetching using response stream as first attempt,
      // await here and then either call fulFill, or if dupe, return false
      const fetcher = new ResponseStreamAsyncFetcher(opts);
      const res = await fetcher.load();
      switch (res) {
        case "dupe":
          this.removeReqResp(networkId);
          return false;

        case "fetched":
          streamingConsume = true;
          break;
      }

      // if not consumed via takeStream, attempt async loading
      if (!streamingConsume) {
        this.addAsyncFetch(opts, contentLen);
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
          { requestId },
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
          { url, networkId, ...formatErr(e), ...this.logDetails },
          "recorder",
        );
        return false;
      }
    }

    const rewritten = await this.rewriteResponse(reqresp, mimeType);

    // if in browser context, and not also intercepted in page context
    // serialize here, as won't be getting a loadingFinished message for it
    if (
      isBrowserContext &&
      !reqresp.inPageContext &&
      !reqresp.asyncLoading &&
      reqresp.payload
    ) {
      this.removeReqResp(networkId);
      await this.serializeToWARC(reqresp);
    }

    // not rewritten, and not streaming, return false to continue
    if (!rewritten && !streamingConsume) {
      if (!reqresp.payload) {
        logger.error(
          "Unable to get payload skipping recording",
          { url, ...this.logDetails },
          "recorder",
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
      const { resourceType } = reqresp;
      const msg =
        resourceType === "document"
          ? "document not loaded in browser, possibly other URLs missing"
          : "URL not loaded in browser";

      logger.debug(msg, { url, resourceType, e }, "recorder");
    }

    return true;
  }

  addAsyncFetch(opts: NetworkLoadAsyncFetchOptions, contentLen: number = -1) {
    let fetcher: AsyncFetcher;

    if (
      opts.reqresp.method !== "GET" ||
      contentLen > MAX_NETWORK_LOAD_SIZE ||
      !opts.reqresp.inPageContext
    ) {
      fetcher = new AsyncFetcher(opts);
    } else {
      fetcher = new NetworkLoadStreamAsyncFetcher(opts);
    }
    void this.fetcherQ.add(() => fetcher.load());
  }

  addExternalFetch(url: string, cdp: CDPSession) {
    logger.debug(
      "Handling fetch from behavior",
      { url, ...this.logDetails },
      "recorder",
    );
    const reqresp = new RequestResponseInfo("0");
    reqresp.url = url;
    reqresp.method = "GET";
    reqresp.frameId = this.mainFrameId || undefined;
    const fetcher = new NetworkLoadStreamAsyncFetcher({
      reqresp,
      recorder: this,
      cdp,
      networkId: "0",
    });
    void this.fetcherQ.add(() => fetcher.load());
    // return true if successful
    return true;
  }

  async blockPageResponse(
    url: string,
    reqresp: RequestResponseInfo,
    responseHeaders?: Protocol.Fetch.HeaderEntry[],
  ): Promise<Protocol.Network.ErrorReason | undefined> {
    if (reqresp.isRedirectStatus()) {
      try {
        let loc = this.getLocation(responseHeaders);
        if (loc) {
          loc = new URL(loc, url).href;

          if (this.pageSeed && this.pageSeed.isExcluded(loc)) {
            logger.warn(
              "Skipping page that redirects to excluded URL",
              { newUrl: loc, origUrl: this.pageUrl },
              "recorder",
            );

            return "BlockedByResponse";
          }
        }
      } catch (e) {
        // ignore
        logger.debug("Redirect check error", e, "recorder");
      }
    }
  }

  startPage({ pageid, url }: { pageid: string; url: string }) {
    this.pageid = pageid;
    this.pageUrl = url;
    this.logDetails = { page: url, workerid: this.workerid };
    if (this.pendingRequests && this.pendingRequests.size) {
      logger.debug(
        "Interrupting timed out requests, moving to next page",
        this.logDetails,
        "recorder",
      );
    }
    this.pendingRequests = new Map();
    this.skipIds = new Set();
    this.skipRangeUrls = new Map<string, number>();
    this.pageFinished = false;
    this.pageInfo = {
      pageid,
      urls: {},
      url,
      counts: { jsErrors: 0 },
      tsStatus: 999,
    };
    this.mainFrameId = null;
  }

  addPageRecord(reqresp: RequestResponseInfo) {
    if (this.isValidUrl(reqresp.url)) {
      const { status, resourceType: type } = reqresp;
      const mime = reqresp.getMimeType();
      const info: PageInfoValue = { status, mime, type };
      if (reqresp.errorText) {
        info.error = reqresp.errorText;
      }
      //TODO: revisit if we want to record this later
      // if (reqresp.fromCache) {
      //   info.fromBrowserCache = true;
      // }
      this.pageInfo.urls[reqresp.getCanonURL()] = info;
    }
  }

  writePageInfoRecord() {
    const text = JSON.stringify(this.pageInfo, null, 2);

    const url = this.pageUrl;

    this.writer.writeNewResourceRecord(
      {
        buffer: new TextEncoder().encode(text),
        resourceType: "pageinfo",
        contentType: "application/json",
        url,
      },
      { type: "pageinfo", url },
      "recorder",
    );

    return this.pageInfo.ts;
  }

  async awaitPageResources() {
    for (const [requestId, reqresp] of this.pendingRequests.entries()) {
      if (reqresp.payload && !reqresp.asyncLoading) {
        this.removeReqResp(requestId);
        await this.serializeToWARC(reqresp);
        // if no url, and not fetch intercept or async loading,
        // drop this request, as it was not being loaded
      } else if (
        !reqresp.url ||
        (!reqresp.intercepting && !reqresp.asyncLoading)
      ) {
        logger.debug(
          "Removing pending request that was never fetched",
          { requestId, url: reqresp.url, ...this.logDetails },
          "recorder",
        );
        this.removeReqResp(requestId);
      }
    }

    let numPending = this.pendingRequests.size;

    let pending = [];
    while (
      numPending &&
      !this.pageFinished &&
      !this.crawler.interruptReason &&
      !this.crawler.postCrawling
    ) {
      pending = [];
      for (const [requestId, reqresp] of this.pendingRequests.entries()) {
        const url = reqresp.url || "";
        const entry: {
          requestId: string;
          url: string;
          expectedSize?: number;
          readSize?: number;
          resourceType?: string;
        } = { requestId, url };
        if (reqresp.expectedSize) {
          entry.expectedSize = reqresp.expectedSize;
        }
        if (reqresp.readSize) {
          entry.readSize = reqresp.readSize;
        }
        if (reqresp.resourceType) {
          entry.resourceType = reqresp.resourceType;
        }
        pending.push(entry);
      }

      logger.debug(
        "Finishing pending requests for page",
        { numPending, pending, ...this.logDetails },
        "recorder",
      );
      await sleep(5.0);
      numPending = this.pendingRequests.size;
    }

    if (this.pendingRequests.size) {
      logger.warn(
        "Dropping timed out requests",
        { numPending, pending, ...this.logDetails },
        "recorder",
      );
      for (const requestId of this.pendingRequests.keys()) {
        this.removeReqResp(requestId);
      }
    }
  }

  async onClosePage() {
    // Any page-specific handling before page is closed.
    this.frameIdToExecId = null;

    this.pageFinished = true;
  }

  async onDone(timeout: number) {
    await this.crawlState.setStatus("pending-wait");

    const finishFetch = async () => {
      logger.debug("Finishing Fetcher Queue", this.logDetails, "recorder");
      await this.fetcherQ.onIdle();
    };

    if (timeout > 0) {
      await timedRun(
        finishFetch(),
        timeout,
        "Finishing Fetch Timed Out",
        this.logDetails,
        "recorder",
      );
    }

    logger.debug("Finishing WARC writing", this.logDetails, "recorder");

    await this.writer.flush();
  }

  shouldSkip(
    headers: Protocol.Network.Headers,
    url?: string,
    method?: string,
    resourceType?: string,
  ) {
    if (headers && !method) {
      method = headers[":method"];
    }

    // only check if url is provided, since it is optional
    if (url && !this.isValidUrl(url)) {
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
      (headers["accept"] === MIME_EVENT_STREAM ||
        headers["Accept"] === MIME_EVENT_STREAM)
    ) {
      return true;
    }

    return false;
  }

  async rewriteResponse(reqresp: RequestResponseInfo, contentType: string) {
    const { url, extraOpts, payload } = reqresp;

    // don't rewrite if payload is missing or too big
    if (!payload || !payload.length || payload.length > MAX_TEXT_REWRITE_SIZE) {
      return false;
    }

    let newString = null;
    let string = null;

    switch (contentType) {
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
        const rw = getCustomRewriter(url, isHTMLMime(contentType));

        if (rw) {
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
        "recorder",
      );
      reqresp.payload = encoder.encode(newString);
      reqresp.isRemoveRange = true;
      return true;
    } else {
      return false;
    }
  }

  isEssentialResource(resourceType: string, contentType: string) {
    if (resourceType === "script" || resourceType === "stylesheet") {
      return true;
    }

    if (RW_MIME_TYPES.includes(contentType)) {
      return true;
    }

    return false;
  }

  shouldStream(
    contentLength: number,
    responseStatusCode: number,
    resourceType: string,
    mimeType: string,
  ) {
    // if contentLength is too large even for rewriting, always stream, will not do rewriting
    // even if text
    if (contentLength > MAX_TEXT_REWRITE_SIZE) {
      return true;
    }

    // if contentLength larger but is essential resource, do stream
    // otherwise full fetch for rewriting
    if (
      contentLength > MAX_BROWSER_DEFAULT_FETCH_SIZE &&
      !this.isEssentialResource(resourceType, mimeType)
    ) {
      return true;
    }

    // if contentLength is unknown, also stream if its an essential resource and not 3xx / 4xx / 5xx
    // status code, as these codes may have no content-length, and are likely small
    if (
      contentLength < 0 &&
      !this.isEssentialResource(resourceType, mimeType) &&
      responseStatusCode >= 200 &&
      responseStatusCode < 300
    ) {
      return true;
    }

    return false;
  }

  protected getMimeType(
    headers?: Protocol.Fetch.HeaderEntry[] | { name: string; value: string }[],
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

  protected getLocation(
    headers?: Protocol.Fetch.HeaderEntry[] | { name: string; value: string }[],
  ) {
    if (!headers) {
      return null;
    }
    for (const header of headers) {
      if (header.name.toLowerCase() === "location") {
        return header.value;
      }
    }

    return null;
  }

  protected _getContentLen(headers?: Protocol.Fetch.HeaderEntry[]) {
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
      const reqresp = new RequestResponseInfo(requestId);
      this.pendingRequests.set(requestId, reqresp);
      return reqresp;
    } else {
      const reqresp = this.pendingRequests.get(requestId);
      if (reqresp && requestId !== reqresp.requestId) {
        logger.warn(
          "Invalid request id",
          { requestId, actualRequestId: reqresp.requestId },
          "recorder",
        );
      }
      return reqresp;
    }
  }

  removeReqResp(requestId: string, allowReuse = false) {
    const reqresp = this.pendingRequests.get(requestId);
    if (reqresp) {
      const { url, requestId } = reqresp;
      logNetwork("Removing reqresp", { requestId, url });
    }
    this.pendingRequests.delete(requestId);
    if (!allowReuse) {
      this.skipIds.add(requestId);
    }
    return reqresp;
  }

  async serializeToWARC(reqresp: RequestResponseInfo) {
    // always include in pageinfo record if going to serialize to WARC
    // even if serialization does not happen
    this.addPageRecord(reqresp);

    const { url, method, status, payload, requestId } = reqresp;

    // Specifically log skipping cached resources
    if (reqresp.isCached()) {
      logger.debug(
        "Skipping cached resource, should be already recorded",
        { url, status },
        "recorder",
      );
      return;
    } else if (reqresp.shouldSkipSave()) {
      logger.debug(
        "Skipping writing request/response",
        {
          requestId,
          url,
          method,
          status,
          payloadLength: (payload && payload.length) || 0,
        },
        "recorder",
      );
      return;
    }

    if (
      url &&
      method === "GET" &&
      !isRedirectStatus(status) &&
      !(await this.crawlState.addIfNoDupe(WRITE_DUPE_KEY, url, status))
    ) {
      logNetwork("Skipping dupe", { url, status, ...this.logDetails });
      return;
    }

    const responseRecord = createResponse(reqresp, this.pageid);
    const requestRecord = createRequest(reqresp, responseRecord, this.pageid);

    this.writer.writeRecordPair(responseRecord, requestRecord);
  }

  async directFetchCapture({
    url,
    headers,
    cdp,
  }: DirectFetchRequest): Promise<DirectFetchResponse> {
    const reqresp = new RequestResponseInfo("0");
    const ts = new Date();

    const cookie = await this.getCookieString(cdp, url);
    if (cookie) {
      headers["Cookie"] = cookie;
    }

    reqresp.url = url;
    reqresp.method = "GET";
    reqresp.requestHeaders = headers;
    reqresp.ts = ts;

    let mime: string = "";

    const filter = (resp: Response) => {
      // only direct load 200 responses
      if (resp.status !== 200) {
        return false;
      }

      const ct = resp.headers.get("content-type");
      if (ct) {
        mime = ct.split(";")[0];
      }

      const result = !isHTMLMime(mime);

      if (result) {
        logger.info(
          "Directly fetching page URL without browser",
          { url, ...this.logDetails },
          "fetch",
        );
      }

      return result;
    };

    // ignore dupes: if previous URL was not a page, still load as page. if previous was page,
    // should not get here, as dupe pages tracked via seen list
    const fetcher = new AsyncFetcher({
      reqresp,
      recorder: this,
      networkId: "0",
      filter,
      ignoreDupe: true,
      manualRedirect: true,
    });
    const res = await fetcher.load();

    // if we get here, resource was not filtered out, has status code of 200

    this.addPageRecord(reqresp);

    const fetched = res === "fetched";

    if (
      url === this.pageUrl &&
      fetched &&
      (!this.pageInfo.ts || 200 < this.pageInfo.tsStatus)
    ) {
      logger.debug("Setting page timestamp", { ts, url, status: 200 });
      this.pageInfo.ts = ts;
      this.pageInfo.tsStatus = 200;
    }

    return { fetched, mime, ts };
  }

  async getCookieString(cdp: CDPSession, url: string): Promise<string> {
    try {
      const cookieList: string[] = [];
      const { cookies } = await cdp.send("Network.getCookies", { urls: [url] });
      for (const { name, value } of cookies) {
        cookieList.push(`${name}=${value}`);
      }

      return cookieList.join(";");
    } catch (e) {
      logger.warn("Error getting cookies", { page: url, e }, "recorder");
      return "";
    }
  }
}

// =================================================================
class AsyncFetcher {
  reqresp: RequestResponseInfo;

  networkId: string;
  filter?: (resp: Response) => boolean;
  ignoreDupe = false;

  maxFetchSize: number;

  recorder: Recorder;

  manualRedirect = false;

  constructor({
    reqresp,
    expectedSize = -1,
    recorder,
    networkId,
    filter = undefined,
    ignoreDupe = false,
    maxFetchSize = MAX_BROWSER_DEFAULT_FETCH_SIZE,
    manualRedirect = false,
  }: AsyncFetchOptions) {
    this.reqresp = reqresp;
    this.reqresp.expectedSize = expectedSize;
    this.reqresp.asyncLoading = true;

    this.networkId = networkId;
    this.filter = filter;
    this.ignoreDupe = ignoreDupe;

    this.recorder = recorder;

    this.maxFetchSize = maxFetchSize;

    this.manualRedirect = manualRedirect;
  }

  async load() {
    const { reqresp, recorder, networkId } = this;
    const { url, status } = reqresp;

    const { pageid, crawlState, gzip, logDetails } = recorder;

    let fetched = "notfetched";

    try {
      if (
        reqresp.method === "GET" &&
        url &&
        !(await crawlState.addIfNoDupe(ASYNC_FETCH_DUPE_KEY, url, status))
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
        maxMemSize: this.maxFetchSize,
      });

      try {
        let readSize = await serializer.digestRecord();
        if (serializer.httpHeadersBuff) {
          readSize -= serializer.httpHeadersBuff.length;
        }
        reqresp.readSize = readSize;
        // set truncated field and recompute header buff
        if (reqresp.truncated) {
          responseRecord.warcHeaders.headers.set(
            "WARC-Truncated",
            reqresp.truncated,
          );
          // todo: keep this internal in warcio after adding new header
          serializer.warcHeadersBuff = encoder.encode(
            responseRecord.warcHeaders.toString(),
          );
        }
      } catch (e) {
        logger.error(
          "Error reading + digesting payload",
          { url, ...formatErr(e), ...logDetails },
          "recorder",
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
          "recorder",
        );
      } else {
        logger.warn(
          "Async fetch: possible response size mismatch",
          {
            type: this.constructor.name,
            size: reqresp.readSize,
            expected: reqresp.expectedSize,
            url,
            ...logDetails,
          },
          "recorder",
        );
        if (status === 206 || status === 200) {
          void serializer.externalBuffer?.purge();
          await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url, status);
          return "notfetched";
        }
      }

      const externalBuffer: TempFileBuffer =
        serializer.externalBuffer as TempFileBuffer;

      if (externalBuffer) {
        const { currSize, buffers, fh } = externalBuffer;

        // if fully buffered in memory, then populate the payload to return to browser
        if (buffers && buffers.length && !fh) {
          reqresp.payload = Buffer.concat(buffers, currSize);
          externalBuffer.buffers = [reqresp.payload];
        } else if (fh) {
          logger.debug(
            "Large payload written to WARC, but not returned to browser (would require rereading into memory)",
            { url, actualSize: reqresp.readSize, maxSize: this.maxFetchSize },
            "recorder",
          );
        }
      }

      if (Object.keys(reqresp.extraOpts).length) {
        responseRecord.warcHeaders.headers.set(
          "WARC-JSON-Metadata",
          JSON.stringify(reqresp.extraOpts),
        );
      }

      recorder.writer.writeRecordPair(
        responseRecord,
        requestRecord,
        serializer,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      await crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url!, status);
      if (e.message === "response-filtered-out") {
        throw e;
      }
      logger.debug(
        "Streaming Fetch Error",
        { url, networkId, ...formatErr(e), ...logDetails },
        "recorder",
      );
      // indicate response is ultimately not valid
      reqresp.status = 0;
      reqresp.errorText = e.message;
    } finally {
      recorder.addPageRecord(reqresp);
      // exclude direct fetch request with fake id
      if (networkId !== "0") {
        recorder.removeReqResp(networkId);
      }
    }

    return fetched;
  }

  async _doFetch() {
    const { reqresp } = this;
    const { method, url } = reqresp;
    logger.debug("Async started: fetch", { url }, "recorder");

    const headers = reqresp.getRequestHeadersDict();

    let dispatcher = getProxyDispatcher();

    if (dispatcher) {
      dispatcher = dispatcher.compose((dispatch) => {
        return (opts, handler) => {
          if (opts.headers) {
            reqresp.requestHeaders = opts.headers as Record<string, string>;
          }
          return dispatch(opts, handler);
        };
      });
    }

    const resp = await fetch(url!, {
      method,
      headers,
      body: reqresp.postData || undefined,
      redirect: this.manualRedirect ? "manual" : "follow",
      dispatcher,
    });

    if (this.filter && !this.filter(resp)) {
      // if redirect and cancelled, read whole buffer to avoid possible node error event
      if (resp.status >= 300 && resp.status < 400) {
        await resp.arrayBuffer();
      } else {
        // otherwise, just cancel
        resp.body?.cancel().catch(() => {});
      }
      throw new Error("response-filtered-out");
    }

    if (
      reqresp.expectedSize < 0 &&
      resp.headers.get("content-length") &&
      !resp.headers.get("content-encoding")
    ) {
      reqresp.expectedSize = Number(resp.headers.get("content-length") || -1);
    }

    if (reqresp.expectedSize === 0) {
      reqresp.fillFetchResponse(resp);
      reqresp.payload = new Uint8Array();
      return;
    } else if (!resp.body) {
      throw new Error("fetch body missing, fetch aborted");
    }

    reqresp.fillFetchResponse(resp);

    return this.takeReader(resp.body.getReader());
  }

  async *takeReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        size += value.length;
        yield value;
      }
    } catch (e) {
      logger.warn(
        "takeReader interrupted",
        {
          size,
          url: this.reqresp.url,
          ...formatErr(e),
          ...this.recorder.logDetails,
        },
        "recorder",
      );
      this.reqresp.truncated = "disconnect";
    }
  }

  async *takeStreamIter(cdp: CDPSession, stream: Protocol.IO.StreamHandle) {
    let size = 0;
    try {
      while (true) {
        const { data, base64Encoded, eof } = await cdp.send("IO.read", {
          handle: stream,
          size: TAKE_STREAM_BUFF_SIZE,
        });
        const buff = Buffer.from(data, base64Encoded ? "base64" : "utf-8");

        size += buff.length;
        yield buff;

        if (eof) {
          break;
        }
      }
    } catch (e) {
      logger.warn(
        "takeStream interrupted",
        {
          size,
          url: this.reqresp.url,
          ...formatErr(e),
          ...this.recorder.logDetails,
        },
        "recorder",
      );
      this.reqresp.truncated = "disconnect";
    }
  }
}

// =================================================================
class ResponseStreamAsyncFetcher extends AsyncFetcher {
  cdp: CDPSession;
  requestId: string;

  constructor(opts: ResponseStreamAsyncFetchOptions) {
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

  constructor(opts: NetworkLoadAsyncFetchOptions) {
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
        { url, ...formatErr(e), ...this.recorder.logDetails },
        "recorder",
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
        "recorder",
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

    reqresp.setStatus(httpStatusCode || 200);
    reqresp.responseHeaders = headers || {};

    return this.takeStreamIter(cdp, stream);
  }
}

// =================================================================
// response
function createResponse(
  reqresp: RequestResponseInfo,
  pageid: string,
  contentIter?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
) {
  if (reqresp.isRemoveRange && reqresp.status === 206) {
    reqresp.setStatus(200);
  }

  const url = reqresp.url;
  const warcVersion = "WARC/1.1";
  const statusline = `HTTP/1.1 ${reqresp.status} ${reqresp.statusText}`;
  const date = new Date(reqresp.ts).toISOString();

  if (!reqresp.payload) {
    reqresp.payload = new Uint8Array();
  }

  const httpHeaders = reqresp.getResponseHeadersDict(reqresp.payload.length);

  const warcHeaders: Record<string, string> = {
    "WARC-Page-ID": pageid,
  };

  if (reqresp.protocols.length) {
    warcHeaders["WARC-Protocol"] = reqresp.protocols.join(", ");
  }

  if (reqresp.cipher) {
    warcHeaders["WARC-Cipher-Suite"] = reqresp.cipher;
  }

  if (reqresp.resourceType) {
    warcHeaders["WARC-Resource-Type"] = reqresp.resourceType;
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
    contentIter,
  );
}

// =================================================================
// request
function createRequest(
  reqresp: RequestResponseInfo,
  responseRecord: WARCRecord,
  pageid: string,
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

  if (reqresp.resourceType) {
    warcHeaders["WARC-Resource-Type"] = reqresp.resourceType;
  }

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
    requestBody,
  );
}
