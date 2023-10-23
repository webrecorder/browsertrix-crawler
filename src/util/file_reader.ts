import fs from "fs";
import path from "path";

const MAX_DEPTH = 2;

export function collectAllFileSources(fileOrDir: string, ext = null, depth = 0) : string[] {
  const resolvedPath = path.resolve(fileOrDir);

  if (depth >= MAX_DEPTH) {
    console.warn(`WARN: MAX_DEPTH of ${MAX_DEPTH} reached traversing "${resolvedPath}"`);
    return [];
  }

  const stat = fs.statSync(resolvedPath);

  if (stat.isFile() && (ext === null || path.extname(resolvedPath) === ext)) {
    const contents = fs.readFileSync(resolvedPath);
    return [`/* src: ${resolvedPath} */\n\n${contents}`];
  }

  if (stat.isDirectory()) {
    const files = fs.readdirSync(resolvedPath);
    return files.reduce((acc: string[], next: string) => {
      const nextPath = path.join(fileOrDir, next);
      return [...acc, ...collectAllFileSources(nextPath, ext, depth + 1)];
    }, []);
  }

  if (depth === 0) {
    console.warn(`WARN: The provided path "${resolvedPath}" is not a .js file or directory.`);
  }

  return [];
}
