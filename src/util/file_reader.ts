import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fetch } from "undici";
import util from "util";
import { exec as execCallback } from "child_process";

import { formatErr, logger } from "./logger.js";
import { getProxyDispatcher } from "./proxy.js";
import { parseRecorderFlowJson } from "./flowbehavior.js";

const exec = util.promisify(execCallback);

const MAX_DEPTH = 5;

// Add .ts to allowed extensions when we can support it
const ALLOWED_EXTS = [".js", ".json"];

const BEHAVIOR_MIMES = [
  "application/json",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
];

const SEED_LIST_MIMES = ["text/plain"];

export type FileSource = {
  path: string;
  contents: string;
};

export type FileSources = FileSource[];

async function getTempFile(
  filename: string,
  dirPrefix: string,
): Promise<string> {
  const tmpDir = path.join(
    os.tmpdir(),
    `${dirPrefix}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await fsp.mkdir(tmpDir, { recursive: true });
  return path.join(tmpDir, filename);
}

async function writeUrlContentsToFile(
  url: string,
  pathPrefix: string,
  allowedMimes: string[],
  pathDefaultExt: string,
) {
  const res = await fetch(url, { dispatcher: getProxyDispatcher() });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!allowedMimes.includes(ct)) {
    throw new Error(
      `Invalid Content-Type: ${ct}, expected one of: ${allowedMimes.join(",")}`,
    );
  }
  const fileContents = await res.text();

  const filename =
    path.basename(new URL(url).pathname) || "index." + pathDefaultExt;
  const filepath = await getTempFile(filename, pathPrefix);

  await fsp.writeFile(filepath, fileContents);
  return filepath;
}

export async function collectOnlineSeedFile(url: string): Promise<string> {
  try {
    const filepath = await writeUrlContentsToFile(
      url,
      "seeds-",
      SEED_LIST_MIMES,
      ".txt",
    );
    logger.info("Seed file downloaded", { url, path: filepath });
    return filepath;
  } catch (e) {
    logger.fatal("Error downloading seed file from URL", {
      url,
      ...formatErr(e),
    });
    throw e;
  }
}

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

  const tmpDir = path.join(
    os.tmpdir(),
    `behaviors-repo-${crypto.randomBytes(4).toString("hex")}`,
  );

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
    logger.fatal(
      "Error downloading custom behaviors from Git repo",
      { url: urlStripped, ...formatErr(e) },
      "behavior",
    );
  }
  return [];
}

async function collectOnlineBehavior(url: string): Promise<FileSources> {
  try {
    const behaviorFilepath = await writeUrlContentsToFile(
      url,
      "behaviors-",
      BEHAVIOR_MIMES,
      ".js",
    );
    logger.info(
      "Custom behavior file downloaded",
      { url, path: behaviorFilepath },
      "behavior",
    );
    return await collectLocalPathBehaviors(behaviorFilepath, 0, url);
  } catch (e) {
    logger.fatal(
      "Error downloading custom behavior from URL",
      { url, ...formatErr(e) },
      "behavior",
    );
  }
  return [];
}

async function collectLocalPathBehaviors(
  fileOrDir: string,
  depth = 0,
  source?: string,
): Promise<FileSources> {
  const resolvedPath = path.resolve(fileOrDir);
  const filename = path.basename(resolvedPath);

  if (depth >= MAX_DEPTH) {
    logger.warn(
      `Max depth of ${MAX_DEPTH} reached traversing "${resolvedPath}"`,
      {},
      "behavior",
    );
    return [];
  }

  const behaviors: FileSources = [];

  try {
    const stat = await fsp.stat(resolvedPath);

    if (stat.isFile() && ALLOWED_EXTS.includes(path.extname(resolvedPath))) {
      source = source ?? filename;
      logger.info("Custom behavior script added", { source }, "behavior");
      let contents = await fsp.readFile(resolvedPath, { encoding: "utf-8" });
      if (path.extname(resolvedPath) === ".json") {
        try {
          contents = parseRecorderFlowJson(contents, source);
        } catch (e) {
          logger.fatal(
            "Unable to parse recorder flow JSON, ignored",
            formatErr(e),
            "behavior",
          );
        }
      }

      return [
        {
          path: resolvedPath,
          contents: `/* src: ${resolvedPath} */\n\n${contents}`,
        },
      ];
    }

    const isDir = stat.isDirectory();

    // ignore .git directory of git repositories
    if (isDir && filename === ".git") {
      return [];
    }

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
        const newBehaviors = await collectLocalPathBehaviors(
          filePath,
          depth + 1,
        );
        behaviors.push(...newBehaviors);
      }
    }
  } catch (e) {
    logger.fatal(
      "Error fetching local custom behaviors",
      { path: resolvedPath, ...formatErr(e) },
      "behavior",
    );
  }

  if (!behaviors && depth === 0) {
    logger.fatal(
      "No custom behaviors found at specified path",
      { path: resolvedPath },
      "behavior",
    );
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
