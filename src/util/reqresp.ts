import { getCustomRewriter, getStatusText } from "@webrecorder/wabac";

import { Protocol } from "puppeteer-core";
import { postToGetUrl } from "warcio";
import { HTML_TYPES } from "./constants.js";
import { Response } from "undici";

const CONTENT_LENGTH = "content-length";
const CONTENT_RANGE = "content-range";
const RANGE = "range";
const CONTENT_TYPE = "content-type";
const EXCLUDE_HEADERS = ["content-encoding", "transfer-encoding"];

// max URL length for post/put payload-converted URLs
export const MAX_URL_LENGTH = 4096;

// max length for single query arg for post/put converted URLs
const MAX_ARG_LEN = 512;

// ===========================================================================
export class RequestResponseInfo {
  ts: Date = new Date();

  requestId: string;

  method?: string;
  url!: string;
  protocol?: string = "HTTP/1.1";

  mimeType?: string;

  // request data
  requestHeaders?: Record<string, string>;
  requestHeadersText?: string;

  postData?: string;
  hasPostData: boolean = false;

  // response data
  status: number = 0;
  statusText?: string;

  errorText?: string;

  responseHeaders?: Record<string, string>;
  responseHeadersList?: { name: string; value: string }[];
  responseHeadersText?: string;

  payload?: Uint8Array;
  isRemoveRange = false;

  // fetchContinued - avoid duplicate fetch response handling
  fetchContinued = false;

  // is handled in page context
  inPageContext = false;

  // misc
  fromServiceWorker = false;
  fromCache = false;

  frameId?: string;

  resourceType?: string;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraOpts: Record<string, any> = {};

  // stats
  readSize: number = 0;
  expectedSize: number = 0;

  // set to true to indicate request intercepted via Fetch.requestPaused
  intercepting = false;

  // set to true to indicate async loading in progress
  asyncLoading: boolean = false;

  // set to add truncated message
  truncated?: string;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  setStatus(status: number, statusText?: string) {
    this.status = status;
    this.statusText = statusText || getStatusText(this.status);
  }

  fillFetchRequestPaused(params: Protocol.Fetch.RequestPausedEvent) {
    this.fillRequest(params.request, params.resourceType);

    if (params.responseStatusCode) {
      this.setStatus(params.responseStatusCode, params.responseStatusText);
    }

    this.responseHeadersList = params.responseHeaders;

    this.intercepting = true;

    this.frameId = params.frameId;
  }

  fillRequest(request: Protocol.Network.Request, resourceType: string) {
    this.url = request.url;
    this.method = request.method;
    if (!this.requestHeaders) {
      this.requestHeaders = request.headers;
    }
    this.postData = request.postData;
    this.hasPostData = request.hasPostData || false;

    if (resourceType) {
      this.resourceType = resourceType.toLowerCase();
    }
  }

  fillResponse(response: Protocol.Network.Response, resourceType?: string) {
    // if initial fetch was a 200, but now replacing with 304, don't!
    if (
      response.status == 304 &&
      this.status &&
      this.status != 304 &&
      this.url
    ) {
      return;
    }

    this.url = response.url.split("#")[0];

    this.setStatus(response.status, response.statusText);

    this.protocol = response.protocol;

    if (resourceType) {
      this.resourceType = resourceType.toLowerCase();
    }

    if (response.requestHeaders) {
      this.requestHeaders = response.requestHeaders;
    }
    if (response.requestHeadersText) {
      this.requestHeadersText = response.requestHeadersText;
    }

    this.responseHeaders = response.headers;

    if (response.headersText) {
      this.responseHeadersText = response.headersText;
    }

    this.fromServiceWorker = !!response.fromServiceWorker;

    if (response.securityDetails) {
      const issuer: string = response.securityDetails.issuer || "";
      const ctc: string =
        response.securityDetails.certificateTransparencyCompliance ===
        "compliant"
          ? "1"
          : "0";
      this.extraOpts.cert = { issuer, ctc };
    }
  }

  isRedirectStatus() {
    return isRedirectStatus(this.status);
  }

  isSelfRedirect() {
    if (!this.isRedirectStatus()) {
      return false;
    }

    try {
      const headers = new Headers(this.getResponseHeadersDict());
      const location = headers.get("location") || "";
      const redirUrl = new URL(location, this.url).href;
      return this.url === redirUrl;
    } catch (e) {
      return false;
    }
  }

  fillResponseReceivedExtraInfo(
    params: Protocol.Network.ResponseReceivedExtraInfoEvent,
  ) {
    // this.responseHeaders = params.headers;
    // if (params.headersText) {
    //   this.responseHeadersText = params.headersText;
    // }
    this.extraOpts.ipType = params.resourceIPAddressSpace;
  }

  fillFetchResponse(response: Response) {
    this.responseHeaders = Object.fromEntries(response.headers);
    this.setStatus(response.status, response.statusText);
  }

  fillRequestExtraInfo(
    params: Protocol.Network.RequestWillBeSentExtraInfoEvent,
  ) {
    this.requestHeaders = params.headers;
  }

  getResponseHeadersText() {
    let headers = `${this.protocol} ${this.status} ${this.statusText}\r\n`;

    if (this.responseHeaders) {
      for (const header of Object.keys(this.responseHeaders)) {
        headers += `${header}: ${this.responseHeaders[header].replace(
          /\n/g,
          ", ",
        )}\r\n`;
      }
    }
    headers += "\r\n";
    return headers;
  }

  hasRequest() {
    return this.method && (this.requestHeaders || this.requestHeadersText);
  }

  getRequestHeadersDict() {
    return this._getHeadersDict(this.requestHeaders);
  }

  getResponseHeadersDict(length = 0) {
    return this._getHeadersDict(
      this.responseHeaders,
      this.responseHeadersList,
      length,
    );
  }

  _getHeadersDict(
    headersDict?: Record<string, string>,
    headersList?: { name: string; value: string }[],
    actualContentLength = 0,
  ) {
    if (!headersDict && headersList) {
      headersDict = {};

      for (const header of headersList) {
        let headerName = header.name.toLowerCase();
        if (header.name.startsWith(":")) {
          continue;
        }
        if (actualContentLength && headerName === CONTENT_LENGTH) {
          headersDict[headerName] = "" + actualContentLength;
          continue;
        }
        if (
          EXCLUDE_HEADERS.includes(headerName) ||
          (this.isRemoveRange &&
            (headerName === CONTENT_RANGE || headerName === RANGE))
        ) {
          headerName = "x-orig-" + headerName;
        }
        headersDict[headerName] = this._encodeHeaderValue(header.value);
      }
    }

    if (!headersDict) {
      return {};
    }

    for (const key of Object.keys(headersDict)) {
      if (key[0] === ":") {
        delete headersDict[key];
        continue;
      }
      const keyLower = key.toLowerCase();
      if (actualContentLength && keyLower === CONTENT_LENGTH) {
        headersDict[key] = "" + actualContentLength;
        continue;
      }
      const value = this._encodeHeaderValue(headersDict[key]);

      if (
        EXCLUDE_HEADERS.includes(keyLower) ||
        (this.isRemoveRange &&
          (keyLower === CONTENT_RANGE || keyLower === RANGE))
      ) {
        headersDict["x-orig-" + key] = value;
        delete headersDict[key];
      } else {
        headersDict[key] = value;
      }
    }

    return headersDict;
  }

  getMimeType() {
    if (this.mimeType) {
      return this.mimeType;
    }

    const headers = new Headers(this.getResponseHeadersDict());
    const contentType = headers.get(CONTENT_TYPE);

    if (!contentType) {
      return;
    }

    return contentType.split(";")[0];
  }

  isValidBinary() {
    if (!this.payload) {
      return false;
    }

    const length = this.payload.length;

    const headers = new Headers(this.getResponseHeadersDict());
    const contentType = headers.get(CONTENT_TYPE);
    const contentLength = headers.get(CONTENT_LENGTH);

    if (Number(contentLength) !== length) {
      return false;
    }

    if (contentType && contentType.startsWith("text/html")) {
      return false;
    }

    return true;
  }

  isCached() {
    return this.fromCache && !this.payload;
  }

  deleteRange() {
    if (this.requestHeaders) {
      delete this.requestHeaders["range"];
      delete this.requestHeaders["Range"];
    }
  }

  shouldSkipSave() {
    // skip cached, OPTIONS/HEAD responses, and 304 responses
    if (
      this.fromCache ||
      (this.method && ["OPTIONS", "HEAD"].includes(this.method)) ||
      this.status == 304
    ) {
      return true;
    }

    // skip no payload response only if its not a redirect
    if (!this.payload && !this.isRedirectStatus()) {
      return true;
    }

    if (this.status === 206) {
      const headers = new Headers(this.getResponseHeadersDict());
      const contentLength: number = parseInt(
        headers.get(CONTENT_LENGTH) || "0",
      );
      const contentRange = headers.get(CONTENT_RANGE);
      if (contentRange !== `bytes 0-${contentLength - 1}/${contentLength}`) {
        return false;
      }
    }

    return false;
  }

  getCanonURL(): string {
    if (!this.method || this.method === "GET") {
      return this.url;
    }

    const convData = {
      url: this.url,
      headers: new Headers(this.getRequestHeadersDict()),
      method: this.method,
      postData: this.postData || "",
    };

    if (postToGetUrl(convData)) {
      // if not custom rewrite, truncate to avoid extra long URLs
      if (getCustomRewriter(this.url, isHTMLMime(this.getMimeType() || ""))) {
        return convData.url;
      }

      try {
        const url = new URL(convData.url);
        for (const [key, value] of url.searchParams.entries()) {
          if (value && value.length > MAX_ARG_LEN) {
            url.searchParams.set(key, value.slice(0, MAX_ARG_LEN));
          }
        }
        convData.url = url.href;
      } catch (e) {
        //ignore
      }
      return convData.url.slice(0, MAX_URL_LENGTH);
    }

    return this.url;
  }

  _encodeHeaderValue(value: string) {
    // check if not ASCII, then encode, replace encoded newlines
    // eslint-disable-next-line no-control-regex
    if (!/^[\x00-\x7F]*$/.test(value)) {
      value = encodeURI(value).replace(/%0A/g, ", ");
    }
    // replace newlines with spaces
    return value.replace(/\n/g, ", ");
  }
}

export function isHTMLMime(mime: string) {
  return HTML_TYPES.includes(mime);
}

export function isRedirectStatus(status: number) {
  return status >= 300 && status < 400 && status !== 304;
}
