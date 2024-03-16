import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const MAX_DEPTH = 2;

export function collectAllFileSources(
  fileOrDir: string,
  ext?: string,
  depth = 0,
): { path: string; contents: string }[] {
  const resolvedPath = path.resolve(fileOrDir);

  if (depth >= MAX_DEPTH) {
    console.warn(
      `WARN: MAX_DEPTH of ${MAX_DEPTH} reached traversing "${resolvedPath}"`,
    );
    return [];
  }

  const stat = fs.statSync(resolvedPath);

  if (stat.isFile() && (ext === null || path.extname(resolvedPath) === ext)) {
    const contents = fs.readFileSync(resolvedPath);
    return [
      {
        path: resolvedPath,
        contents: `/* src: ${resolvedPath} */\n\n${contents}`,
      },
    ];
  }

  if (stat.isDirectory()) {
    const files = fs.readdirSync(resolvedPath);
    return files.reduce(
      (acc: { path: string; contents: string }[], next: string) => {
        const nextPath = path.join(fileOrDir, next);
        return [...acc, ...collectAllFileSources(nextPath, ext, depth + 1)];
      },
      [],
    );
  }

  if (depth === 0) {
    console.warn(
      `WARN: The provided path "${resolvedPath}" is not a .js file or directory.`,
    );
  }

  return [];
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
