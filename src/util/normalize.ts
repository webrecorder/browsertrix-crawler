import { Options, default as normalize } from "normalize-url";
import { logger } from "./logger.js";

// URL normalization options for consistent URL handling across the crawler
// Query parameters are sorted alphabetically by the normalize-url library
export let normalizeUrlOpts: Options = {
  defaultProtocol: "https",
  stripAuthentication: false,
  stripTextFragment: false,
  stripWWW: false,
  stripHash: false,
  removeTrailingSlash: false,
  removeSingleSlash: false,
  removeExplicitPort: false,
  sortQueryParameters: true,
  removeQueryParameters: false,
  removePath: false,
};

export function normalizeUrl(url: string) {
  try {
    return normalize(url, normalizeUrlOpts);
  } catch (e) {
    logger.warn("normalizeUrl failed for url, using unmodified url", { url });
    return url;
  }
}

export function setRemoveQueryParams() {
  normalizeUrlOpts = { ...normalizeUrlOpts, removeQueryParameters: true };
}
