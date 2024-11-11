import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fetch } from "undici";
import util from "util";
import { exec as execCallback } from "child_process";

import { logger } from "./logger.js";

const exec = util.promisify(execCallback);

const MAX_DEPTH = 2;

// Add .ts to allowed extensions when we can support it
const ALLOWED_EXTS = [".js"];

export type FileSource = {
  path: string;
  contents: string;
};

export type FileSources = FileSource[];

export async function collectCustomBehaviors(
  sources: string[],
): Promise<FileSources> {
  const collectedSources: FileSources = [];

  for (const fileSource of sources) {
    if (fileSource.startsWith("git+")) {
      const newSources = await collectGitBehaviors(fileSource);
      collectedSources.push(...newSources);
    } else if (fileSource.startsWith("http")) {
      const newSources = await collectOnlineBehavior(fileSource);
      collectedSources.push(...newSources);
    } else {
      const newSources = await collectLocalPathBehaviors(fileSource);
      collectedSources.push(...newSources);
    }
  }

  return collectedSources;
}

async function collectGitBehaviors(gitUrl: string): Promise<FileSources> {
  const url = gitUrl.split("git+").pop() || "";
  const params = new URL(url).searchParams;
  const branch = params.get("branch") || "";
  const relPath = params.get("path") || "";
  const urlStripped = url.split("?")[0];

  const tmpDir = `/tmp/behaviors-repo-${crypto.randomBytes(4).toString("hex")}`;

  let cloneCommand = "git clone ";
  if (branch) {
    cloneCommand += `-b ${branch} --single-branch `;
  }
  cloneCommand += `${urlStripped} ${tmpDir}`;

  let pathToCollect = tmpDir;
  if (relPath) {
    pathToCollect = path.join(tmpDir, relPath);
  }

  try {
    await exec(cloneCommand);
    logger.info(
      "Custom behavior files downloaded from git repo",
      { url: urlStripped },
      "behavior",
    );
    return await collectLocalPathBehaviors(pathToCollect);
  } catch (e) {
    logger.error(
      "Error downloading custom behaviors from Git repo",
      { url: urlStripped, error: e },
      "behavior",
    );
  }
  return [];
}

async function collectOnlineBehavior(url: string): Promise<FileSources> {
  const filename = crypto.randomBytes(4).toString("hex") + ".js";
  const behaviorFilepath = `/app/behaviors/${filename}`;

  try {
    const res = await fetch(url);
    const fileContents = await res.text();
    await fsp.writeFile(behaviorFilepath, fileContents);
    logger.info(
      "Custom behavior file downloaded",
      { url, path: behaviorFilepath },
      "behavior",
    );
    return await collectLocalPathBehaviors(behaviorFilepath);
  } catch (e) {
    logger.error(
      "Error downloading custom behavior from URL",
      { url, error: e },
      "behavior",
    );
  }
  return [];
}

async function collectLocalPathBehaviors(
  fileOrDir: string,
  depth = 0,
): Promise<FileSources> {
  const resolvedPath = path.resolve(fileOrDir);

  if (depth >= MAX_DEPTH) {
    logger.warn(
      `Max depth of ${MAX_DEPTH} reached traversing "${resolvedPath}"`,
      {},
      "behavior",
    );
    return [];
  }

  const stat = await fsp.stat(resolvedPath);

  if (stat.isFile() && ALLOWED_EXTS.includes(path.extname(resolvedPath))) {
    const contents = await fsp.readFile(resolvedPath);
    return [
      {
        path: resolvedPath,
        contents: `/* src: ${resolvedPath} */\n\n${contents}`,
      },
    ];
  }

  const behaviors: FileSources = [];

  const isDir = stat.isDirectory();

  if (!isDir && depth === 0) {
    logger.warn(
      "The provided path is not a .js file or directory",
      { path: resolvedPath },
      "behavior",
    );
  }

  if (isDir) {
    const files = await fsp.readdir(resolvedPath);
    for (const file of files) {
      const filePath = path.join(resolvedPath, file);
      const newBehaviors = await collectLocalPathBehaviors(filePath, depth + 1);
      behaviors.push(...newBehaviors);
    }
  }

  return behaviors;
}

export async function getInfoString() {
  const packageFileJSON = JSON.parse(
    await fsp.readFile(new URL("../../package.json", import.meta.url), {
      encoding: "utf-8",
    }),
  );
  const warcioPackageJSON = JSON.parse(
    await fsp.readFile(
      new URL("../../node_modules/warcio/package.json", import.meta.url),
      { encoding: "utf-8" },
    ),
  );

  return `Browsertrix-Crawler ${packageFileJSON.version} (with warcio.js ${warcioPackageJSON.version})`;
}
