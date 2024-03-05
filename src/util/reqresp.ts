// @ts-expect-error TODO fill in why error is expected
import { getStatusText } from "@webrecorder/wabac/src/utils.js";

import { Protocol } from "puppeteer-core";
import { postToGetUrl } from "warcio";

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
  requestHeaders?: Record<string, string>;
  requestHeadersText?: string;

  postData?: string;
  hasPostData: boolean = false;

  // response data
  status: number = 0;
  statusText?: string;

  responseHeaders?: Record<string, string>;
  responseHeadersList?: { name: string; value: string }[];
  responseHeadersText?: string;

  payload?: Uint8Array;

  // misc
  fromServiceWorker: boolean = false;

  frameId?: string;

  fetch: boolean = false;

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
    this.url = params.request.url;
    this.method = params.request.method;
    if (!this.requestHeaders) {
      this.requestHeaders = params.request.headers;
    }
    this.postData = params.request.postData;
    this.hasPostData = params.request.hasPostData || false;

    this.status = params.responseStatusCode || 0;
    this.statusText = params.responseStatusText || getStatusText(this.status);

    this.responseHeadersList = params.responseHeaders;

    this.fetch = true;

    if (params.resourceType) {
      this.resourceType = params.resourceType.toLowerCase();
    }

    this.frameId = params.frameId;
  }

  fillResponse(response: Protocol.Network.Response, type?: string) {
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

    this.status = response.status;
    this.statusText = response.statusText || getStatusText(this.status);

    this.protocol = response.protocol;

    if (type) {
      this.resourceType = type.toLowerCase();
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

  isSelfRedirect() {
    if (this.status < 300 || this.status >= 400 || this.status === 304) {
      return false;
    }
    try {
      const headers = new Headers(this.responseHeaders);
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
    this.status = response.status;
    this.statusText = response.statusText || getStatusText(this.status);
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
        if (EXCLUDE_HEADERS.includes(headerName)) {
          headerName = "x-orig-" + headerName;
          continue;
        }
        if (actualContentLength && headerName === CONTENT_LENGTH) {
          headersDict[headerName] = "" + actualContentLength;
          continue;
        }
        headersDict[headerName] = header.value.replace(/\n/g, ", ");
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
      headersDict[key] = headersDict[key].replace(/\n/g, ", ");
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

  shouldSkipSave() {
    // skip OPTIONS/HEAD responses, and 304 or 206 responses
    if (
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
      headers: new Headers(this.requestHeaders),
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
}
