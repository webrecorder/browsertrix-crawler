export const HTML_TYPES = [
  "text/html",
  "application/xhtml",
  "application/xhtml+xml",
];
export const WAIT_UNTIL_OPTS = [
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2",
];

export const SERVICE_WORKER_OPTS = [
  "disabled",
  "disabled-if-profile",
  "enabled",
] as const;

export type ServiceWorkerOpt = (typeof SERVICE_WORKER_OPTS)[number];

export const DETECT_SITEMAP = "<detect>";

export const EXTRACT_TEXT_TYPES = ["to-pages", "to-warc", "final-to-warc"];

export const BEHAVIOR_LOG_FUNC = "__bx_log";
export const ADD_LINK_FUNC = "__bx_addLink";
export const FETCH_FUNC = "__bx_fetch";

export const MAX_DEPTH = 1000000;
export const DEFAULT_MAX_RETRIES = 2;

export const FETCH_HEADERS_TIMEOUT_SECS = 30;
export const PAGE_OP_TIMEOUT_SECS = 5;
export const SITEMAP_INITIAL_FETCH_TIMEOUT_SECS = 30;

export type ExtractSelector = {
  selector: string;
  extract: string;
  isAttribute: boolean;
};

export const DEFAULT_SELECTORS: ExtractSelector[] = [
  {
    selector: "a[href]",
    extract: "href",
    isAttribute: false,
  },
];

export const BEHAVIOR_TYPES = [
  "autoplay",
  "autofetch",
  "autoscroll",
  "autoclick",
  "siteSpecific",
];

export const DISPLAY = ":99";

export enum ExitCodes {
  Success = 0,
  //GenericError = 1,
  OutOfSpace = 3,
  CrawlFailed = 9,
  BrowserCrashed = 10,
  InterruptedGraceful = 11,
  InterruptedImmediate = 13,
  FatalError = 17,
  RedisGone = 18,
  UploadError = 19,
  ProxyError = 21,

  // used to indicate crawl should be failed, not just restarted
  FailCrawl = 1001,
}
