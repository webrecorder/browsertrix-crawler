import child_process from "child_process";
import fs from "fs";
import util from "util";

import { logger } from "./util/logger.js";
import { WARCWriter } from "./util/warcwriter.js";

import { WARCRecord } from "warcio";

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
      parsed.pathname === "/watch" ||
      parsed.pathname.startsWith("/shorts") ||
      parsed.pathname.startsWith("/embed")
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

export async function maybeYtdlp(
  url: string,
  writer: WARCWriter,
  downloadsDir: string,
): Promise<object | undefined> {
  // In the future we'll support more sites but right now we only check YouTube
  if (!isYoutubeVideo(url)) {
    return;
  }

  const metadata = await ytdlpInfo(url);
  const videos = [];
  if (metadata) {
    const video = await ytdlpYoutube(url, writer, downloadsDir);
    if (video) {
      videos.push(video);
    } else {
      return;
    }
  }
  const videoInfo = {
    infoJson: metadata,
    videos,
  };

  return videoInfo;
}

async function ytdlpYoutube(
  url: string,
  writer: WARCWriter,
  downloadsDir: string,
): Promise<object | undefined> {
  const videoId = youtubeId(url);
  if (videoId === undefined) {
    logger.info(
      `Unable to identify video ID for video at URL ${url}; not capturing`,
    );
    return;
  }
  const fuzzyUrl = `https://youtube.fuzzy.replayweb.page/videoplayback?id=${videoId}`;

  const videoPath = `${downloadsDir}/${videoId}.mp4`;
  logger.info("Downloading YouTube video", { videoId });

  try {
    await ytdlpDownloadMp4(url, videoPath);
  } catch (e) {
    logger.error(`Failed to download video at URL ${url}`, e);
    return;
  }

  const reader = fs.createReadStream(videoPath);
  const record = WARCRecord.create(
    {
      url: `https://youtube.fuzzy.replayweb.page/videoplayback?id=${videoId}`,
      date: new Date().toISOString(),
      type: "resource",
      warcHeaders: { "Content-Type": "video/mp4" },
    },
    reader,
  );
  writer.writeSingleRecord(record, () => fs.rmSync(videoPath));

  return {
    format: "youtube",
    videoId,
    url: fuzzyUrl,
  };
}

export async function ytdlpDownloadMp4(url: string, path: string) {
  return execFile("yt-dlp", [
    // --no-js-runtimes followed by --js-runtimes is so that we
    // can skip the default deno runtime and force the use of node.
    "--no-js-runtimes",
    "--js-runtimes",
    "node",
    "--preset-alias",
    // Downloads best MP4-compatible audio/video and remuxes into
    // a single MP4 file
    "mp4",
    url,
    // Output to a known path
    "--output",
    path,
  ]);
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
    // Note that embedded playlists have a similar, overlapping format:
    // https://www.youtube.com/embed/videoseries?list=playlistid
    // We currently do NOT want to capture these.
    if (parsed.pathname.startsWith("/embed")) {
      const id = parsed.pathname.replace(/^\/embed\//, "");
      if (id === "videoseries") {
        return;
      } else {
        return id;
      }
    }
  }
}
