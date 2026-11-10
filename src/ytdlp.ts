import child_process from "child_process";
import util from "util";

import { logger } from "./util/logger.js";

const execFile = util.promisify(child_process.execFile);

type YtdlpFormat = {
  protocol: string;
  format: string;
  url: string;
};

export type YtdlpResponse = {
  formats: YtdlpFormat[];
};

export function isYoutubeVideo(url: string) {
  return isYoutubeShort(url) || isYoutubeWatchPage(url);
}

export function isYoutubeShort(url: string) {
  const parsed = new URL(url);
  if (
    parsed.host.match(/(www.)?youtu.be/) &&
    parsed.pathname.startsWith("/shorts/")
  ) {
    return true;
  }
  return false;
}

export function isYoutubeWatchPage(url: string) {
  const parsed = new URL(url);
  if (parsed.host.match(/(www.)?youtu.be/)) {
    return true;
  }
  if (parsed.host.match(/(www.)?(youtube.com|youtube-nocookie.com)/)) {
    return (
      parsed.pathname === "/watch" || parsed.pathname.startsWith("/shorts")
    );
  }
  return false;
}

export async function ytdlpInfo(
  url: string,
): Promise<YtdlpResponse | undefined> {
  let subprocess;
  try {
    subprocess = await execFile("yt-dlp", [
      // --no-js-runtimes followed by --js-runtimes is so that we
      // can skip the default deno runtime and force the use of node.
      "--no-js-runtimes",
      "--js-runtimes",
      "node",
      // dumps to stdout, as opposed to --write-info-json,
      // which writes to disk.
      "--dump-json",
      // --skip-download ensures we only fetch metadata.
      "--skip-download",
      url,
    ]);
  } catch (e) {
    logger.error(`Unable to fetch metadata for video at URL ${url}`, e);
    return;
  }

  try {
    return JSON.parse(subprocess.stdout);
  } catch (e) {
    logger.error(`yt-dlp returned invalid JSON for video at url ${url}`, e);
    return;
  }
}

export function youtubeId(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (!parsed) {
    return;
  }
  // https://youtu.be/videoid
  if (parsed.hostname.match(/(www.?)youtu.be/)) {
    return parsed.pathname.replace(/^\//, "");
  }
  if (parsed.hostname.match(/(www.)youtube.com/)) {
    // https://www.youtube.com/watch?v=videoid
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") || undefined;
    }
    // https://www.youtube.com/embed/videoid
    if (parsed.pathname.startsWith("/embed")) {
      return parsed.pathname.replace(/^\/embed\//, "");
    }
  }
}
