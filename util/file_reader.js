import fs from "fs";
import path from "path";
import crypto from "crypto";

const MAX_DEPTH = 2;

export async function determineFileSource(fileOrUrl, ext = null, logger) {
  if (typeof(fileOrUrl) === "string") {
    if (fileOrUrl.startsWith("http")) {
      return await collectOnlineFileSource(fileOrUrl, logger);
    } else {
      return collectAllFileSources(fileOrUrl, ext);
    }
  } else if (typeof(fileOrUrl) === "object") {
    const returnArray = [];
    for (const f of fileOrUrl) {
      returnArray.concat(await determineFileSource(f, ext, logger));
    }
    return returnArray;
  }
}

export async function collectOnlineFileSource(url, logger) {
  const filename = crypto.randomBytes(4).toString("hex") + ".js";
  await fetch(url)
    .then(res => res.text())
    .then(file => {return fs.promises.writeFile("/app/behaviors/" + filename, file);})
    .catch(err => {
      logger.error(err);
    });
  return collectAllFileSources("/app/behaviors", ".js");
}

export function collectAllFileSources(fileOrDir, ext = null, depth = 0) {
  const resolvedPath = path.resolve(fileOrDir);

  if (depth >= MAX_DEPTH) {
    console.warn(`WARN: MAX_DEPTH of ${MAX_DEPTH} reached traversing "${resolvedPath}"`);
    return [];
  }

  const stat = fs.statSync(resolvedPath);

  if (stat.isFile && (ext === null || path.extname(resolvedPath) === ext)) {
    const contents = fs.readFileSync(resolvedPath);
    return [`/* src: ${resolvedPath} */\n\n${contents}`];
  }

  if (stat.isDirectory) {
    const files = fs.readdirSync(resolvedPath);
    return files.reduce((acc, next) => {
      const nextPath = path.join(fileOrDir, next);
      return [...acc, ...collectAllFileSources(nextPath, ext, depth + 1)];
    }, []);
  }

  if (depth === 0) {
    console.warn(`WARN: The provided path "${resolvedPath}" is not a .js file or directory.`);
    return [];
  }
}
