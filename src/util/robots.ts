import { fetch } from "undici";
import robotsParser, { Robot } from "robots-parser";

import { LogDetails, logger } from "./logger.js";
import { RedisCrawlState } from "./state.js";
import { getProxyDispatcher } from "./proxy.js";
import { sleep } from "./timing.js";

let headers: Record<string, string> = {};
let crawlState: RedisCrawlState | null = null;

export function setRobotsConfig(
  _headers: Record<string, string>,
  state: RedisCrawlState,
) {
  headers = _headers;
  crawlState = state;
}

export async function isDisallowedByRobots(
  url: string,
  logDetails: LogDetails,
  robotsAgent: string,
) {
  const robots = await fetchAndParseRobots(url, logDetails);
  return robots && robots.isDisallowed(url, robotsAgent);
}

async function fetchAndParseRobots(
  url: string,
  logDetails: LogDetails,
): Promise<Robot | null> {
  // Fetch robots.txt for url's host and return parser.
  // Results are cached by robots.txt URL in Redis using an LRU cache
  // implementation that retains the 100 most recently used values.
  const urlParser = new URL(url);
  const robotsUrl = `${urlParser.origin}/robots.txt`;

  const cachedRobots = await crawlState!.getCachedRobots(robotsUrl);
  // empty string is valid cached empty robots, so check for null
  if (cachedRobots !== null) {
    // don't create parser, just skip check if empty string
    return cachedRobots ? robotsParser(robotsUrl, cachedRobots) : null;
  }

  try {
    logger.debug(
      "Fetching robots.txt",
      { url: robotsUrl, ...logDetails },
      "robots",
    );
    const content = await fetchRobots(robotsUrl);
    if (content === null) {
      return null;
    }

    logger.debug(
      "Caching robots.txt body",
      { url: robotsUrl, ...logDetails },
      "robots",
    );
    await crawlState!.setCachedRobots(robotsUrl, content);

    // empty string cached, but no need to create parser
    return content ? robotsParser(robotsUrl, content) : null;
  } catch (e) {
    // ignore
  }
  logger.warn(
    "Failed to fetch robots.txt",
    {
      url: robotsUrl,
      ...logDetails,
    },
    "robots",
  );
  return null;
}

async function fetchRobots(url: string): Promise<string | null> {
  while (true) {
    const resp = await fetch(url, {
      headers,
      dispatcher: getProxyDispatcher(url),
    });

    if (resp.ok) {
      return await resp.text();
    }

    if (resp.status === 429 || resp.status === 503) {
      const retry = resp.headers.get("retry-after");

      if (retry) {
        logger.debug(
          "Robots.txt fetch: Retry after",
          { url, retrySeconds: retry },
          "robots",
        );
        await sleep(parseInt(retry));
        continue;
      }

      logger.debug(
        "Robots.txt temporarily not fetched, will retry later",
        { url, status: resp.status },
        "robots",
      );

      return null;
    }

    logger.debug(
      "Robots.txt invalid, storing empty value",
      { url, status: resp.status },
      "robots",
    );

    // for other status errors, just return empty
    return "";
  }
}
