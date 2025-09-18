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

export const HASH_DUPE_KEY = "dupe";

export enum BxFunctionBindings {
  BehaviorLogFunc = "__bx_log",
  AddLinkFunc = "__bx_addLink",
  FetchFunc = "__bx_fetch",
  AddToSeenSet = "__bx_addSet",

  InitFlow = "__bx_initFlow",
  NextFlowStep = "__bx_nextFlowStep",

  ContentCheckFailed = "__bx_contentCheckFailed",
}

export const MAX_DEPTH = 1000000;
export const DEFAULT_MAX_RETRIES = 2;

export const FETCH_HEADERS_TIMEOUT_SECS = 30;
export const PAGE_OP_TIMEOUT_SECS = 5;
export const SITEMAP_INITIAL_FETCH_TIMEOUT_SECS = 30;

export const ROBOTS_CACHE_LIMIT = 100;

// max JS dialogs (alert/prompt) to allow per page
export const MAX_JS_DIALOG_PER_PAGE = 10;

export type ExtractSelector = {
  selector: string;
  extract: string;
  attrOnly: boolean;
};

export const DEFAULT_SELECTORS: ExtractSelector[] = [
  {
    selector: "a[href]",
    extract: "href",
    attrOnly: false,
  },
];

export const DEFAULT_CRAWL_ID_TEMPLATE = "@hostname-@id";

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
  GenericError = 1,
  Failed = 9,
  OutOfSpace = 3,
  BrowserCrashed = 10,
  SignalInterrupted = 11,
  FailedLimit = 12,
  SignalInterruptedForce = 13,
  SizeLimit = 14,
  TimeLimit = 15,
  DiskUtilization = 16,
  Fatal = 17,
  ProxyError = 21,
  UploadFailed = 22,
}

export enum InterruptReason {
  SizeLimit = 1,
  TimeLimit = 2,
  FailedLimit = 3,
  DiskUtilization = 4,
  BrowserCrashed = 5,
  SignalInterrupted = 6,
  CrawlPaused = 7,
}
