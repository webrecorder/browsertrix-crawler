import fs from "fs";
import path from "path";
import crypto from "crypto";

const MAX_DEPTH = 2;

export async function determineFileSource(fileOrUrl, ext = null) {
  // Currently assuming if we pass more than one param, they're *all* URLs
  if (typeof(fileOrUrl) === "string") {
    if (fileOrUrl.startsWith("http") || typeof(fileOrUrl) === "object") {
      return await collectOnlineFileSource(fileOrUrl);
    } else {
      return collectAllFileSources(fileOrUrl, ext);
    }
  }
}

export async function collectOnlineFileSource(url) {
  if (typeof(url) === "string") {
    collectSingleOnlineFile(url);
  } else if (typeof(url) === "object") {
    for (const u of url) {
      await collectSingleOnlineFile(u);
    }
  }
  return collectAllFileSources("/app/behaviors", ".js");
}

export async function collectSingleOnlineFile(url) {
	const filename = crypto.randomBytes(4).toString('hex') + ".js";
  await fetch(url)
    .then(res => res.text())
    .then(file => {console.debug(file); return fs.promises.writeFile("/app/behaviors/" + filename, file);})
    .then(() => {
      console.log("done");
    }).catch(err => {
      console.log(err);
    });
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
