
export const HTML_TYPES = ["text/html", "application/xhtml", "application/xhtml+xml"];
export const WAIT_UNTIL_OPTS = ["load", "domcontentloaded", "networkidle0", "networkidle2"];
export const EXTRACT_TEXT_TYPES = ["to-pages", "to-warc", "final-to-warc"];

export const BEHAVIOR_LOG_FUNC = "__bx_log";
export const ADD_LINK_FUNC = "__bx_addLink";
export const MAX_DEPTH = 1000000;

export const DEFAULT_SELECTORS = [{
  selector: "a[href]",
  extract: "href",
  isAttribute: false
}];

