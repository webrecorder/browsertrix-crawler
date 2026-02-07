import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { request } from "undici";
import util from "util";
import { exec as execCallback } from "child_process";

import { formatErr, logger } from "./logger.js";
import { getFollowRedirectDispatcher } from "./proxy.js";
import { parseRecorderFlowJson } from "./flowbehavior.js";

const exec = util.promisify(execCallback);

const MAX_DEPTH = 5;

// Add .ts to allowed extensions when we can support it
const ALLOWED_EXTS = [".js", ".json"];

export type FileSource = {
  path: string;
  contents: string;
};

export type FileSources = FileSource[];

async function getTempFile(
  targetDir: string,
  filename: string,
): Promise<string> {
  return path.join(
    targetDir,
    `${crypto.randomBytes(4).toString("hex")}-${filename}`,
  );
}

export async function replaceDir(sourceDir: string, destDir: string) {
  // remove destDir if it exists
  try {
    await fsp.rm(destDir, { force: true, recursive: true });
  } catch (e) {
    // ignore
  }

  // Move new dir to new location
  try {
    //await exec(`mv ${sourceDir} ${destDir}`);
    await fsp.rename(sourceDir, destDir);
  } catch (e) {
    logger.fatal("Error moving/renaming directories, should not happen", {
      ...formatErr(e),
    });
  }
}

export async function getFileOrUrlJson(urlOrFile: string) {
  if (!urlOrFile.startsWith("http://") && !urlOrFile.startsWith("https://")) {
    const data = await fsp.readFile(urlOrFile, { encoding: "utf8" });
    return JSON.parse(data);
  }

  const { body } = await request(urlOrFile);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await body.json()) as any;
}

async function writeUrlContentsToFile(
  targetDir: string,
  url: string,
  pathPrefix: string,
  pathDefaultExt: string,
  fetchNew = false,
): Promise<string> {
  const filename =
    path.basename(new URL(url).pathname) || "index." + pathDefaultExt;

  const targetFile = path.join(targetDir, pathPrefix + filename);
  let exists = false;

  try {
    await fsp.access(targetFile, fsp.constants.R_OK | fsp.constants.W_OK);
    exists = true;
  } catch (e) {
    // ignore
  }

  if (exists && !fetchNew) {
    return targetFile;
  }

  try {
    const res = await request(url, {
      dispatcher: getFollowRedirectDispatcher(),
    });
    if (res.statusCode !== 200) {
      throw new Error(`Invalid response, status: ${res.statusCode}`);
    }
    const fileContents = await res.body.text();

    const filepath = await getTempFile(targetDir, filename);

    await fsp.writeFile(filepath, fileContents);

    await fsp.rename(filepath, targetFile);
  } catch (e) {
    if (!exists) {
      throw e;
    }
  }
  return targetFile;
}

export async function collectOnlineSeedFile(
  targetDir: string,
  url: string,
): Promise<string> {
  try {
    const filepath = await writeUrlContentsToFile(
      targetDir,
      url,
      "seeds-",
      ".txt",
      false,
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
  targetDir: string,
  sources: string[],
): Promise<FileSources> {
  const collectedSources: FileSources = [];

  for (const fileSource of sources) {
    if (fileSource.startsWith("git+")) {
      const newSources = await collectGitBehaviors(targetDir, fileSource);
      collectedSources.push(...newSources);
    } else if (fileSource.startsWith("http")) {
      const newSources = await collectOnlineBehavior(targetDir, fileSource);
      collectedSources.push(...newSources);
    } else {
      const newSources = await collectLocalPathBehaviors(fileSource);
      collectedSources.push(...newSources);
    }
  }

  return collectedSources;
}

async function collectGitBehaviors(
  targetDir: string,
  gitUrl: string,
): Promise<FileSources> {
  const url = gitUrl.split("git+").pop() || "";
  const params = new URL(url).searchParams;
  const branch = params.get("branch") || "";
  const relPath = params.get("path") || "";
  const urlStripped = url.split("?")[0];

  const urlHash = crypto.createHash("sha-256").update(url).digest("hex");

  const behaviorsDir = path.join(targetDir, `behaviors-repo-${urlHash}`);

  let exists = false;

  try {
    await fsp.access(behaviorsDir);
    exists = true;
  } catch (e) {
    // ignore
  }

  const tmpDir = path.join(
    targetDir,
    `behaviors-repo-${urlHash}-${crypto.randomBytes(4).toString("hex")}`,
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

  // Download behaviors to temp dir (in downloads directory)
  try {
    await exec(cloneCommand);
    logger.info(
      "Custom behavior files downloaded from git repo",
      { url: urlStripped },
      "behavior",
    );
  } catch (e) {
    if (!exists) {
      logger.fatal(
        "Error downloading custom behaviors from Git repo",
        { url: urlStripped, ...formatErr(e) },
        "behavior",
      );
    } else {
      logger.info(
        "Error re-downloading custom behaviors from Git repo, using existing behaviors",
        { url: urlStripped, ...formatErr(e) },
        "behavior",
      );
      return await collectLocalPathBehaviors(behaviorsDir);
    }
  }

  await replaceDir(pathToCollect, behaviorsDir);

  // remove the rest of the repo that we're not using
  if (relPath) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  return await collectLocalPathBehaviors(behaviorsDir);
}

async function collectOnlineBehavior(
  targetDir: string,
  url: string,
): Promise<FileSources> {
  try {
    const behaviorFilepath = await writeUrlContentsToFile(
      targetDir,
      url,
      "behaviors-",
      ".js",
      true,
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
