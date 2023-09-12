import fs from "fs";
import path from "path";
import https from "https";

const MAX_DEPTH = 2;

export function determineFileSource(fileOrUrl, ext = null) {
  // Currently assuming if we pass more than one param, they're *all* URLs
  if (typeof(fileOrUrl) === "string") {
    if (fileOrUrl.startsWith("http") || typeof(fileOrUrl) === "object") {
      return collectOnlineFileSource(fileOrUrl);
    } else {
      return collectAllFileSources(fileOrUrl, ext);
    }
  }
}

export function collectOnlineFileSource(url) {
  if (typeof(url) === "string") {
    collectSingleOnlineFile(url);
  } else if (typeof(url) === "object") {
    for (const u of url) {
      collectSingleOnlineFile(u);
    }
  }
  return collectAllFileSources("/app/behaviors", ".js");
}

export function collectSingleOnlineFile(url) {
  const split = url.split("/");
  const filename = split[split.length - 1];
  const file = fs.createWriteStream("/app/behaviors/" + filename);
  // TODO handle case where file is sent over HTTP?
  https.get(url, function(response) {
    response.pipe(file);
    file.on("finish", () => {
      file.close();
    });
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
