import PQueue from "p-queue";

import { logger, formatErr } from "./logger.js";
import { sleep, timedRun } from "./timing.js";
import {
  RequestResponseInfo,
  isHTMLMime,
  isRedirectStatus,
} from "./reqresp.js";

import { Dispatcher, request } from "undici";

import {
  getCustomRewriter,
  removeRangeAsQuery,
  rewriteDASH,
  rewriteHLS,
  tsToDate,
} from "@webrecorder/wabac";

import { WARCRecord, multiValueHeader } from "warcio";
import { TempFileBuffer, WARCSerializer } from "warcio/node";
import { WARCWriter } from "./warcwriter.js";
import { LoadState, PageState, RedisCrawlState, WorkerId } from "./state.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { Crawler } from "../crawler.js";
import { getProxyDispatcher } from "./proxy.js";
import { ScopedSeed } from "./seeds.js";
import EventEmitter from "events";
import { DEFAULT_MAX_RETRIES } from "./constants.js";
import { Readable } from "stream";

const MAX_BROWSER_DEFAULT_FETCH_SIZE = 5_000_000;
const MAX_TEXT_REWRITE_SIZE = 25_000_000;

const MAX_NETWORK_LOAD_SIZE = 200_000_000;

const TAKE_STREAM_BUFF_SIZE = 1024 * 64;

const ASYNC_FETCH_DUPE_KEY = "s:fetchdupe";

const WRITE_DUPE_KEY = "s:writedupe";

const MIME_EVENT_STREAM = "text/event-stream";

const RW_MIME_TYPES = [
  "application/x-mpegurl",
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
  ignoreDupe?: boolean;
  maxFetchSize?: number;
  manualRedirect?: boolean;
  useBrowserNetwork?: boolean;
  cdp: CDPSession | null;
};

// =================================================================
export type DirectFetchRequest = {
  url: string;
  headers: Record<string, string>;
  cdp: CDPSession;
  state: PageState;
  crawler: Crawler;
};

// =================================================================
enum SerializeRes {
  // WARC record written
  Success = 0,

  // WARC record writing aborted due to incomplete, should retry
  Aborted = 1,

  // WARC record skipped (eg. dupe, cached) and should not be retried
  Skipped = 2,
}

// =================================================================
export class Recorder extends EventEmitter {
  workerid: WorkerId;

  crawler: Crawler;

  crawlState: RedisCrawlState;

  // fetching using browser network, should be cleared before moving to new page
  browserFetchQ: PQueue;

  // fetching using node, does not need to be cleared before moving to new page
  asyncFetchQ: PQueue;

  pendingRequests!: Map<string, RequestResponseInfo>;
  skipIds!: Set<string>;
  pageInfo!: PageInfoRecord;
  mainFrameId: string | null = null;
  skipRangeUrls!: Map<string, number>;
  skipPageInfo = false;

  swTargetId?: string | null;
  swFrameIds = new Set<string>();
  swUrls = new Set<string>();

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logDetails: Record<string, any> = {};

  pageFinished = false;

  lastErrorText = "";

  gzip = true;

  writer: WARCWriter;

  pageUrl!: string;
  finalPageUrl = "";
  pageid!: string;

  pageSeed?: ScopedSeed;
  pageSeedDepth = 0;
  //minPageDedupeDepth = -1;

  frameIdToExecId: Map<string, number> | null;

  shouldSaveStorage = false;

  stopping = false;

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

    this.shouldSaveStorage = !!crawler.params.saveStorage;

    //this.minPageDedupeDepth = crawler.params.minPageDedupeDepth;

    this.writer = writer;

    this.browserFetchQ = new PQueue({ concurrency: 1 });
    this.asyncFetchQ = new PQueue({ concurrency: 1 });

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
      this.handleLoadingFinished(params, cdp),
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

    if (reqresp.url === this.finalPageUrl) {
      this.finalPageUrl = reqresp.getRedirectUrl();
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
          return this.serializeToWARC(reqresp).catch((e) =>
            logger.warn("Error Serializing to WARC", e, "recorder"),
          );
        } else if (url && reqresp.requestHeaders && type === "Media") {
          this.removeReqResp(requestId);
          logger.warn(
            "Attempt direct fetch of failed request",
            { url, ...this.logDetails },
            "recorder",
          );
          reqresp.deleteRange();
          reqresp.requestId = "0";

          const expectedSize = reqresp.expectedSize ? reqresp.expectedSize : -1;
          this.addAsyncFetch({
            reqresp,
            expectedSize,
            recorder: this,
            cdp: null,
          });
          return;
        }
        break;

      case "net::ERR_HTTP_RESPONSE_CODE_FAILURE":
        logger.warn("Recording empty non-200 status response", {
          url,
          status: reqresp.status,
          errorText,
          type,
          ...this.logDetails,
        });
        return this.serializeToWARC(reqresp).catch((e) =>
          logger.warn("Error Serializing to WARC", e, "recorder"),
        );

      default:
        this.lastErrorText = errorText;
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

  async handleLoadingFinished(
    params: Protocol.Network.LoadingFinishedEvent,
    cdp: CDPSession,
  ) {
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

    if (this.shouldSaveStorage && url === this.finalPageUrl) {
      await this.saveStorage(reqresp, cdp);
    }

    try {
      await this.serializeToWARC(reqresp);
    } catch (e) {
      logger.warn("Error Serializing to WARC", e, "recorder");
    }
  }

  async saveStorage(reqresp: RequestResponseInfo, cdp: CDPSession) {
    try {
      const { url, extraOpts } = reqresp;
      const securityOrigin = new URL(url).origin;

      const local = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin, isLocalStorage: true },
      });
      const session = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin, isLocalStorage: false },
      });

      if (local.entries.length || session.entries.length) {
        extraOpts.storage = JSON.stringify({
          local: local.entries,
          session: session.entries,
        });
      }
    } catch (e) {
      logger.warn("Error getting local/session storage", e, "recorder");
    }
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

    const networkId = params.networkId || "";

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

          this.addAsyncFetch({
            reqresp: reqrespNew,
            expectedSize: parseInt(range.split("/")[1]),
            recorder: this,
            useBrowserNetwork: !isBrowserContext,
            cdp,
          });
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
            useBrowserNetwork: !isBrowserContext,
            cdp,
          });
        }
        return false;
      }
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
        this.skipPageInfo = true;
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
      if (await this.isDupeFetch(reqresp)) {
        this.removeReqResp(networkId);
        return false;
      }

      streamingConsume = await this.fetchResponseBody(requestId, reqresp, cdp);

      // if not consumed via takeStream, attempt async loading
      if (!streamingConsume) {
        this.removeReqResp(networkId);
        const opts: AsyncFetchOptions = {
          reqresp,
          expectedSize: contentLen,
          recorder: this,
          useBrowserNetwork: !isBrowserContext,
          cdp,
        };

        this.addAsyncFetch(opts);
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

    // ** WIP: Experimental page-level dedupe **
    // Will abort page loading in case of duplicate
    // TODO: Write revisit record, track page as a duplicate in page list
    // if (
    //   url === this.pageUrl &&
    //   reqresp.payload &&
    //   this.minPageDedupeDepth >= 0 &&
    //   this.pageSeedDepth >= this.minPageDedupeDepth
    // ) {
    //   const hash =
    //     "sha256:" + createHash("sha256").update(reqresp.payload).digest("hex");
    //   const res = await this.crawlState.getHashDupe(hash);
    //   if (res) {
    //     const { index, crawlId } = res;
    //     const errorReason = "BlockedByResponse";
    //     await cdp.send("Fetch.failRequest", {
    //       requestId,
    //       errorReason,
    //     });
    //     await this.crawlState.addDupeCrawlDependency(crawlId, index);
    //     // await this.crawlState.addConservedSizeStat(
    //     //   size - reqresp.payload.length,
    //     // );
    //     return true;
    //   }
    // }

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

  addAsyncFetch(opts: AsyncFetchOptions) {
    if (!this.stopping) {
      const { cdp, useBrowserNetwork } = opts;
      const fetcher = new AsyncFetcher(opts);
      const fetchQ =
        !!cdp && useBrowserNetwork ? this.browserFetchQ : this.asyncFetchQ;
      void fetchQ.add(() => fetcher.load());
    }
  }

  addExternalFetch(url: string, cdp: CDPSession) {
    const reqresp = new RequestResponseInfo("0");
    reqresp.url = url;
    reqresp.method = "GET";
    reqresp.frameId = this.mainFrameId || undefined;

    const details = { url, ...this.logDetails };

    const fetchIfNotDupe = async () => {
      if (await this.isDupeFetch(reqresp)) {
        logger.debug("Skipping dupe fetch from behavior", details, "recorder");
        return false;
      }

      logger.debug("Handling fetch from behavior", details, "recorder");

      this.addAsyncFetch({ reqresp, recorder: this, cdp });
    };

    void fetchIfNotDupe().catch(() =>
      logger.warn("Error fetching URL from behavior", details, "recorder"),
    );

    // return true to indicate no need for in-browser fetch
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
    this.finalPageUrl = this.pageUrl;
    this.lastErrorText = "";
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
    this.skipPageInfo = false;
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
    if (this.skipPageInfo) {
      logger.debug(
        "Skipping writing pageinfo for blocked page",
        { url: "urn:pageinfo:" + this.pageUrl },
        "recorder",
      );
      return;
    }
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
    this.stopping = true;

    await this.crawlState.setStatus("pending-wait");

    const finishFetch = async () => {
      logger.debug("Finishing Fetcher Queues", this.logDetails, "recorder");
      await this.browserFetchQ.onIdle();
      await this.asyncFetchQ.onIdle();
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

    this.browserFetchQ.clear();
    this.asyncFetchQ.clear();

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

    contentType = contentType.toLowerCase();

    let newString = null;
    let string = null;

    switch (contentType) {
      case "application/x-mpegurl":
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

    if (RW_MIME_TYPES.includes(contentType.toLowerCase())) {
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

  async directFetchCapture({
    url,
    headers,
    cdp,
    crawler,
    state,
  }: DirectFetchRequest): Promise<boolean> {
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
    // if frameId is undefined, will not do browser network fetch
    reqresp.frameId = this.mainFrameId || undefined;

    // ignore dupes: if previous URL was not a page, still load as page. if previous was page,
    // should not get here, as dupe pages tracked via seen list
    const fetcher = new AsyncFetcher({
      reqresp,
      recorder: this,
      ignoreDupe: true,
      manualRedirect: true,
      cdp,
    });

    if (!(await fetcher.loadHeaders())) {
      return false;
    }

    const mime = reqresp.getMimeType() || "";
    // cancel if not 200 or mime is html
    if (reqresp.status !== 200 || isHTMLMime(mime)) {
      await fetcher.doCancel();
      return false;
    }
    if (!this.stopping) {
      state.asyncLoading = true;
      void this.asyncFetchQ.add(() => fetcher.loadDirectPage(state, crawler));
    }
    return true;
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

  async fetchResponseBody(
    requestId: string,
    reqresp: RequestResponseInfo,
    cdp: CDPSession,
  ) {
    const { url } = reqresp;
    try {
      logger.debug("Async started: takeStream", { url }, "recorder");

      const { stream } = await cdp.send("Fetch.takeResponseBodyAsStream", {
        requestId,
      });

      const iter = this.takeStreamIter(reqresp, cdp, stream);

      try {
        // if aborted, allow retrying
        if (
          (await this.serializeToWARC(reqresp, iter, true)) ===
          SerializeRes.Aborted
        ) {
          return false;
        }
      } catch (e) {
        logger.warn("Error Serializing to WARC", e, "recorder");
        return false;
      }
      this.removeReqResp(reqresp.requestId);
      return true;
    } catch (e) {
      logger.debug(
        "Fetch responseBodyAsStream failed, will retry async",
        { url, requestId, error: e, ...this.logDetails },
        "recorder",
      );
      return false;
    }
  }

  async *takeStreamIter(
    reqresp: RequestResponseInfo,
    cdp: CDPSession,
    stream: Protocol.IO.StreamHandle,
  ) {
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
          url: reqresp.url,
          ...formatErr(e),
          ...this.logDetails,
        },
        "recorder",
      );
      reqresp.truncated = "disconnect";
    } finally {
      await this.closeIOStream(stream, cdp, reqresp.url);
    }
  }

  async closeIOStream(stream: string, cdp: CDPSession, url: string) {
    try {
      await cdp.send("IO.close", { handle: stream });
    } catch (e) {
      logger.warn(
        "takeStream close failed",
        { url, ...this.logDetails },
        "recorder",
      );
    }
  }

  async isDupeFetch(reqresp: RequestResponseInfo) {
    const { url, method, status } = reqresp;
    if (
      method === "GET" &&
      url &&
      !(await this.crawlState.addIfNoDupe(ASYNC_FETCH_DUPE_KEY, url, status))
    ) {
      reqresp.asyncLoading = false;
      return true;
    }

    return false;
  }

  async checkStreamingRecordPayload(
    reqresp: RequestResponseInfo,
    serializer: WARCSerializer,
    canRetry: boolean,
  ) {
    const { url } = reqresp;
    const { logDetails } = this;
    try {
      reqresp.readSize = await serializer.digestRecord({
        returnPayloadOnlySize: true,
      });
      // set truncated field and recompute header buff
      if (reqresp.truncated) {
        logger.warn(
          "Response truncated",
          { url, canRetry, ...logDetails },
          "recorder",
        );
        // if retries available, just retry
        if (canRetry) {
          return false;
        }
      }
    } catch (e) {
      logger.error(
        "Error reading + digesting payload",
        { url, canRetry, ...formatErr(e), ...logDetails },
        "recorder",
      );
      return false;
    }

    if (reqresp.readSize === reqresp.expectedSize || reqresp.expectedSize < 0) {
      logger.debug(
        "Async fetch: streaming done",
        {
          size: reqresp.readSize,
          expected: reqresp.expectedSize,
          url,
          ...logDetails,
        },
        "recorder",
      );
    } else {
      logger.warn(
        "Async fetch: skipping, possible response size mismatch",
        {
          type: this.constructor.name,
          size: reqresp.readSize,
          expected: reqresp.expectedSize,
          url,
          canRetry,
          ...logDetails,
        },
        "recorder",
      );
      return false;
    }

    return true;
  }

  async serializeToWARC(
    reqresp: RequestResponseInfo,
    iter?: AsyncIterable<Uint8Array>,
    canRetry = false,
  ): Promise<SerializeRes> {
    // always include in pageinfo record if going to serialize to WARC
    // even if serialization does not happen, indicates this URL was on the page
    this.addPageRecord(reqresp);

    const { pageid, gzip } = this;
    const { url, status, requestId, method, payload } = reqresp;

    // Specifically log skipping cached resources
    if (reqresp.isCached()) {
      logger.debug(
        "Skipping cached resource, should be already recorded",
        { url, status },
        "recorder",
      );
      return SerializeRes.Skipped;
    } else if (!iter && reqresp.shouldSkipSave()) {
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
      return SerializeRes.Skipped;
    }

    if (
      url &&
      method === "GET" &&
      !isRedirectStatus(status) &&
      !(await this.crawlState.addIfNoDupe(WRITE_DUPE_KEY, url, status))
    ) {
      logNetwork("Skipping exact URL dupe in this crawl", {
        url,
        status,
        ...this.logDetails,
      });
      return SerializeRes.Skipped;
    }

    let responseRecord = createResponse(reqresp, pageid, iter);
    const requestRecord = createRequest(reqresp, responseRecord, pageid);

    let serializer = new WARCSerializer(responseRecord, {
      gzip,
      maxMemSize: MAX_BROWSER_DEFAULT_FETCH_SIZE,
    });

    if (iter) {
      if (
        !(await this.checkStreamingRecordPayload(reqresp, serializer, canRetry))
      ) {
        serializer.externalBuffer?.purge();
        await this.crawlState.removeDupe(ASYNC_FETCH_DUPE_KEY, url, status);
        await this.crawlState.removeDupe(WRITE_DUPE_KEY, url, status);
        return SerializeRes.Aborted;
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
            {
              url,
              actualSize: reqresp.readSize,
              maxSize: MAX_BROWSER_DEFAULT_FETCH_SIZE,
            },
            "recorder",
          );
        }
      }
    } else {
      reqresp.readSize = await serializer.digestRecord({
        returnPayloadOnlySize: true,
      });
    }

    const hash = responseRecord.warcPayloadDigest || "";

    const date = responseRecord.warcDate || "";

    const isEmpty = reqresp.readSize === 0;

    let origRecSize = 0;

    if (!isEmpty && url) {
      const res = await this.crawlState.getHashDupe(hash);

      if (res) {
        const { origUrl, origDate, crawlId, index, size } = res;
        origRecSize = size;
        const date = tsToDate(origDate).toISOString();
        // always write revisit here
        // duplicate URLs in same crawl filtered out separately
        serializer.externalBuffer?.purge();
        ({ responseRecord, serializer } = await createRevisitForResponse(
          responseRecord,
          serializer,
          origUrl,
          date,
        ));
        await this.crawlState.addDupeCrawlDependency(crawlId, index);
      } else {
        // no dupe, continue
      }
    }

    let modified = false;

    if (reqresp.truncated) {
      responseRecord.warcHeaders.headers.set(
        "WARC-Truncated",
        reqresp.truncated,
      );
      modified = true;
    }

    if (Object.keys(reqresp.extraOpts).length) {
      responseRecord.warcHeaders.headers.set(
        "WARC-JSON-Metadata",
        JSON.stringify(reqresp.extraOpts),
      );
      modified = true;
    }

    if (modified) {
      serializer.warcHeadersBuff = encoder.encode(
        responseRecord.warcHeaders.toString(),
      );
    }

    const addStatsCallback = async (size: number) => {
      try {
        await this.crawlState.addHashNew(hash, url, date, size, origRecSize);
      } catch (e) {
        logger.warn("Error adding dupe hash", e, "recorder");
      }
    };

    this.writer.writeRecordPair(
      responseRecord,
      requestRecord,
      serializer,
      addStatsCallback,
    );

    this.addPageRecord(reqresp);

    return SerializeRes.Success;
  }
}

// =================================================================
class AsyncFetcher {
  reqresp: RequestResponseInfo;

  ignoreDupe = false;
  useBrowserNetwork = true;

  cdp: CDPSession | null = null;

  stream: string | null = null;
  body?: Dispatcher.BodyMixin & Readable;

  maxFetchSize: number;

  recorder: Recorder;

  manualRedirect = false;

  maxRetries = DEFAULT_MAX_RETRIES;

  constructor({
    reqresp,
    expectedSize = -1,
    recorder,
    ignoreDupe = false,
    maxFetchSize = MAX_BROWSER_DEFAULT_FETCH_SIZE,
    manualRedirect = false,
    useBrowserNetwork = true,
    cdp = null,
  }: AsyncFetchOptions) {
    this.reqresp = reqresp;
    this.reqresp.expectedSize = expectedSize;
    this.reqresp.asyncLoading = true;

    this.ignoreDupe = ignoreDupe;
    this.useBrowserNetwork = useBrowserNetwork;

    this.recorder = recorder;

    this.maxFetchSize = maxFetchSize;

    this.manualRedirect = manualRedirect;

    this.cdp = cdp;
  }

  async load() {
    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      if (!(await this.loadHeaders())) {
        continue;
      }
      if (!(await this.loadBody())) {
        continue;
      }
      return true;
    }
    return false;
  }

  async loadHeaders() {
    let success = false;
    try {
      if (this.useBrowserNetwork) {
        const { method, expectedSize, frameId } = this.reqresp;
        if (
          method !== "GET" ||
          expectedSize > MAX_NETWORK_LOAD_SIZE ||
          !frameId
        ) {
          this.useBrowserNetwork = false;
        }
      }
      if (this.useBrowserNetwork) {
        success = await this.loadHeadersNetwork();
      }

      if (!success) {
        this.useBrowserNetwork = false;
        success = await this.loadHeadersFetch();
      }
    } catch (e) {
      logger.warn(
        "Async load headers failed",
        { ...formatErr(e), url: this.reqresp.url, ...this.recorder.logDetails },
        "fetch",
      );
    }

    return success;
  }

  async loadBody() {
    try {
      const { reqresp, useBrowserNetwork, body, stream, cdp, recorder } = this;

      let iter: AsyncIterable<Uint8Array> | undefined;
      if (reqresp.expectedSize === 0) {
        iter = undefined;
      } else if (stream && useBrowserNetwork && cdp) {
        iter = recorder.takeStreamIter(this.reqresp, cdp, stream);
      } else if (body) {
        iter = this.takeReader(body);
      } else {
        throw new Error("resp body missing");
      }

      if (
        (await recorder.serializeToWARC(reqresp, iter)) === SerializeRes.Skipped
      ) {
        await this.doCancel();
        return false;
      }
      return true;
    } catch (e) {
      logger.warn(
        "Async load body failed",
        { ...formatErr(e), ...this.recorder.logDetails },
        "fetch",
      );
      return false;
    }
  }

  async doCancel() {
    const { body, stream, cdp, reqresp } = this;
    if (body && !body.destroyed) {
      body.destroy();
    }
    if (stream && cdp) {
      await this.recorder.closeIOStream(stream, cdp, reqresp.url);
      this.stream = null;
    }
  }

  async loadHeadersFetch() {
    const { reqresp } = this;
    const { method, url } = reqresp;
    logger.debug("Async started: fetch", { url }, "recorder");

    const headers = reqresp.getRequestHeadersDict();

    let dispatcher = getProxyDispatcher(url, !this.manualRedirect, false);

    dispatcher = dispatcher.compose((dispatch) => {
      return (opts, handler) => {
        if (opts.headers) {
          // store full actual headers that are sent for the request
          reqresp.requestHeaders = opts.headers as Record<string, string>;
        }
        return dispatch(opts, handler);
      };
    });

    const resp = await request(url!, {
      method: (method || "GET") as Dispatcher.HttpMethod,
      headers,
      body: reqresp.postData || undefined,
      dispatcher,
    });

    // do nothing
    resp.body.on("error", () => {});

    for (const [name, value] of Object.entries(resp.headers)) {
      if (value instanceof Array) {
        resp.headers[name] = multiValueHeader(name, value);
      }
    }

    if (
      reqresp.expectedSize < 0 &&
      resp.headers["content-length"] &&
      !resp.headers["content-encoding"]
    ) {
      reqresp.expectedSize = Number(resp.headers["content-length"] || -1);
    }

    if (reqresp.expectedSize === 0) {
      reqresp.fillFetchResponse(resp);
      reqresp.payload = new Uint8Array();
      return true;
    } else if (!resp.body) {
      return false;
    }

    reqresp.fillFetchResponse(resp);
    this.body = resp.body;
    //this.resp = resp;
    return true;
  }

  async loadHeadersNetwork() {
    const { reqresp, cdp } = this;
    if (!cdp) {
      return false;
    }
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
      return false;
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
      return false;
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
      return true;
    }

    reqresp.setStatus(httpStatusCode || 200);
    reqresp.responseHeaders = headers || {};

    this.stream = stream;
    return true;
  }

  async *takeReader(reader: Readable) {
    let size = 0;
    try {
      for await (const value of reader) {
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

  async loadDirectPage(state: PageState, crawler: Crawler) {
    state.asyncLoading = true;

    const success = await this.loadBody();

    this.recorder.addPageRecord(this.reqresp);

    const mime = this.reqresp.getMimeType();

    if (mime) {
      state.mime = mime;
      state.isHTMLPage = isHTMLMime(mime);
    }
    if (success) {
      state.loadState = LoadState.FULL_PAGE_LOADED;
      state.status = 200;
      state.ts = this.reqresp.ts || new Date();
      logger.info(
        "Direct fetch successful",
        { url: this.reqresp.url, mime, workerid: this.recorder.workerid },
        "fetch",
      );
    }
    state.asyncLoading = false;
    await crawler.pageFinished(state);
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
  const statusline = `${reqresp.httpProtocol} ${reqresp.status} ${reqresp.statusText}`;
  const date = new Date(reqresp.ts).toISOString();

  if (!reqresp.payload) {
    reqresp.payload = new Uint8Array();
  }

  const httpHeaders = reqresp.getResponseHeadersDict(reqresp.payload.length);

  const warcHeaders: Record<string, string> = {
    "WARC-Page-ID": pageid,
  };

  if (reqresp.protocols.length) {
    warcHeaders["WARC-Protocol"] = multiValueHeader(
      "WARC-Protocol",
      reqresp.protocols,
    );
  }

  if (reqresp.resourceType) {
    warcHeaders["WARC-Resource-Type"] = reqresp.resourceType;
  }

  if (Object.keys(reqresp.extraOpts).length) {
    warcHeaders["WARC-JSON-Metadata"] = JSON.stringify(reqresp.extraOpts);
  }

  if (!contentIter) {
    contentIter = [reqresp.payload] as Iterable<Uint8Array>;
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
const REVISIT_COPY_HEADERS = [
  "WARC-Page-ID",
  "WARC-Protocol",
  "WARC-Resource-Type",
  "WARC-JSON-Metadata",
];

// =================================================================
// revisit
async function createRevisitForResponse(
  responseRecord: WARCRecord,
  serializer: WARCSerializer,
  refersToUrl: string,
  refersToDate: string,
) {
  const payloadDigestForRevisit = responseRecord.warcPayloadDigest || "";

  const warcHeaders: Record<string, string> = {};

  const origWarcHeaders = responseRecord.warcHeaders.headers;

  for (const header of REVISIT_COPY_HEADERS) {
    if (origWarcHeaders.has(header)) {
      warcHeaders[header] = origWarcHeaders.get(header)!;
    }
  }

  const revisitRecord = WARCRecord.create({
    url: responseRecord.warcTargetURI!,
    date: responseRecord.warcDate!,
    warcVersion: "WARC/1.1",
    type: "revisit",
    warcHeaders,
    refersToUrl,
    refersToDate,
  });
  revisitRecord.httpHeaders = responseRecord.httpHeaders;

  serializer = new WARCSerializer(revisitRecord, {
    gzip: true,
    maxMemSize: MAX_BROWSER_DEFAULT_FETCH_SIZE,
  });

  await serializer.digestRecord({ payloadDigestForRevisit });

  return { serializer, responseRecord: revisitRecord };
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

  const statusline = `${method} ${url.slice(urlParsed.origin.length)} ${
    reqresp.httpProtocol
  }`;

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
