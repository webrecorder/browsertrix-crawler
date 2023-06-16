import {logger} from "./logger.js";

export function is_valid_link(page_url, linked_url, logDetails = {}) {
  console.log("page_url: " + page_url + " " + base_domain(page_url));
  console.log("linked_url : " + linked_url + " " + base_domain(linked_url));
  let parsedUrl = null;
  try {
    parsedUrl = new URL(linked_url.trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      logger.warn("Invalid Seed - URL must start with http:// or https://", {url: linked_url, ...logDetails});
      return false;
    } else if (base_domain(page_url) !== base_domain(linked_url)) {
      logger.warn(`Base domain for linked url: ${linked_url} not same as parent url: ${page_url}`, {url: linked_url, ...logDetails});
      return false;
    }
  } catch (e) {
    logger.warn( {url: linked_url,  exception: e.message,  ...logDetails});
    return false;
  }
  return true;
}

function base_domain(url){
  const parsed_url = new URL(url);
  return parsed_url.hostname.split(".").slice(-2).join(".");
}