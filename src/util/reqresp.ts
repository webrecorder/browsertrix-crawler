// @ts-expect-error TODO fill in why error is expected
import { getStatusText } from "@webrecorder/wabac/src/utils.js";

import { Protocol } from "puppeteer-core";
import { postToGetUrl } from "warcio";
import { HTML_TYPES } from "./constants.js";

const CONTENT_LENGTH = "content-length";
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
  private requestHeadersDict?: Record<string, string>;
  //requestHeadersText?: string;
  requestHeaders = new Headers();

  private responseHeadersDict?: Record<string, string>;
  private responseHeadersList?: { name: string; value: string }[];
  responseHeaders = new Headers();
  //responseHeadersText?: string;

  postData?: string;
  hasPostData: boolean = false;

  // response data
  status: number = 0;
  statusText?: string;

  errorText?: string;

  payload?: Uint8Array;

  // misc
  fromServiceWorker = false;
  fromCache = false;

  frameId?: string;

  fetch = false;

  resourceType?: string;

  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraOpts: Record<string, any> = {};

  // stats
  readSize: number = 0;
  expectedSize: number = 0;

  // set to true to indicate async loading in progress
  asyncLoading: boolean = false;

  // set to add truncated message
  truncated?: string;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  fillFetchRequestPaused(params: Protocol.Fetch.RequestPausedEvent) {
    this.fillRequest(params.request, params.resourceType);

    this.responseHeadersList = params.responseHeaders;
    this.responseHeaders = this.getResponseHeaders();
    this.status = params.responseStatusCode || 0;
    this.statusText = params.responseStatusText || getStatusText(this.status);

    this.fetch = true;

    this.frameId = params.frameId;
  }

  fillRequest(request: Protocol.Network.Request, resourceType: string) {
    this.url = request.url;
    this.method = request.method;
    if (!this.requestHeadersDict) {
      this.requestHeadersDict = request.headers;
    }
    this.requestHeaders = this.getRequestHeaders();
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

    this.setResponseHeaders(
      response.headers,
      response.status,
      response.statusText,
    );

    this.protocol = response.protocol;

    if (resourceType) {
      this.resourceType = resourceType.toLowerCase();
    }

    if (response.requestHeaders) {
      this.requestHeadersDict = response.requestHeaders;
      this.requestHeaders = this.getRequestHeaders();
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
    return this.status >= 300 && this.status < 400 && this.status !== 304;
  }

  isSelfRedirect() {
    if (!this.isRedirectStatus()) {
      return false;
    }

    try {
      const location = this.responseHeaders.get("location") || "";
      const redirUrl = new URL(location, this.url).href;
      return this.url === redirUrl;
    } catch (e) {
      return false;
    }
  }

  fillResponseReceivedExtraInfo(
    params: Protocol.Network.ResponseReceivedExtraInfoEvent,
  ) {
    this.extraOpts.ipType = params.resourceIPAddressSpace;
  }

  fillFetchResponse(response: Response) {
    this.setResponseHeaders(
      Object.fromEntries(response.headers),
      response.status,
      response.statusText,
    );
  }

  fillRequestExtraInfo(
    params: Protocol.Network.RequestWillBeSentExtraInfoEvent,
  ) {
    this.requestHeadersDict = params.headers;
    this.requestHeaders = this.getRequestHeaders();
  }

  hasRequest() {
    return this.method && this.requestHeaders;
  }

  getRequestHeaders() {
    return new Headers(this._getHeadersDict(this.requestHeadersDict));
  }

  getResponseHeaders(length = 0) {
    return new Headers(
      this._getHeadersDict(
        this.responseHeadersDict,
        this.responseHeadersList,
        length,
      ),
    );
  }

  setResponseHeaders(
    headersDict: Record<string, string>,
    status: number,
    statusText?: string,
  ) {
    this.responseHeadersDict = headersDict;
    this.responseHeaders = this.getResponseHeaders();
    this.status = status;
    this.statusText = statusText || getStatusText(this.status);
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
        if (EXCLUDE_HEADERS.includes(headerName)) {
          headerName = "x-orig-" + headerName;
          continue;
        }
        if (actualContentLength && headerName === CONTENT_LENGTH) {
          headersDict[headerName] = "" + actualContentLength;
          continue;
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
      if (EXCLUDE_HEADERS.includes(keyLower)) {
        headersDict["x-orig-" + key] = headersDict[key];
        delete headersDict[key];
        continue;
      }
      if (actualContentLength && keyLower === CONTENT_LENGTH) {
        headersDict[key] = "" + actualContentLength;
        continue;
      }
      headersDict[key] = this._encodeHeaderValue(headersDict[key]);
    }

    return headersDict;
  }

  getMimeType() {
    if (this.mimeType) {
      return this.mimeType;
    }

    const contentType = this.responseHeaders.get(CONTENT_TYPE);

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

    const contentType = this.responseHeaders.get(CONTENT_TYPE);
    const contentLength = this.responseHeaders.get(CONTENT_LENGTH);

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

  shouldSkipSave() {
    // skip cached, OPTIONS/HEAD responses, and 304 or 206 responses
    if (
      this.fromCache ||
      !this.payload ||
      (this.method && ["OPTIONS", "HEAD"].includes(this.method)) ||
      [206, 304].includes(this.status)
    ) {
      return true;
    }

    return false;
  }

  getCanonURL(): string {
    if (!this.method || this.method === "GET") {
      return this.url;
    }

    const convData = {
      url: this.url,
      headers: this.requestHeaders,
      method: this.method,
      postData: this.postData || "",
    };

    if (postToGetUrl(convData)) {
      //this.requestBody = convData.requestBody;
      // truncate to avoid extra long URLs
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
      return encodeURI(value).replace(/%0A/g, ", ");
    }
    // replace newlines with spaces
    return value.replace(/\n/g, ", ");
  }
}

export function isHTMLContentType(contentType: string | null) {
  // just load if no content-type
  if (!contentType) {
    return true;
  }

  const mime = contentType.split(";")[0];

  if (HTML_TYPES.includes(mime)) {
    return true;
  }

  return false;
}
