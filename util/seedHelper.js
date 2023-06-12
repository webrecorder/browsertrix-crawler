import {logger} from "./logger.js";

export function parseUrl(url, logDetails = {}) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url.trim());
  } catch (e) {
    logger.warn("Invalid Seed - not a valid URL", {url, ...logDetails});
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol != "https:") {
    logger.warn("Invalid Seed - URL must start with http:// or https://", {url, ...logDetails});
    parsedUrl = null;
  }

  return parsedUrl;
}