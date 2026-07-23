import { execSync } from "child_process";
import fs from "fs";

test("ensure basic crawl run with docker run passes", async () => {
  execSync(
    "docker run -e ZIP_LINES_PER_BLOCK=16 -e ZIP_CDX_MIN_SIZE=10000 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 6 --collection zipped-cdx-merge --generateWACZ",
  );
});

test("check that indexes/index.cdx.gz and indexes/index.idx exist", () => {
  expect(
    fs.existsSync("test-crawls/collections/zipped-cdx-merge/indexes/index.idx"),
  ).toBe(true);

  expect(
    fs.existsSync(
      "test-crawls/collections/zipped-cdx-merge/indexes/index.cdx.gz",
    ),
  ).toBe(true);
});

test("verify that index entries are as expected", async () => {
  const indexBuff = fs.readFileSync(
    "test-crawls/collections/zipped-cdx-merge/indexes/index.idx",
    { encoding: "utf-8" },
  );
  for (const line of indexBuff.trim().split("\n")) {
    if (line.startsWith("!meta 0")) {
      continue;
    }
    const prefixIndex = line.indexOf(" ");
    const prefix = line.slice(0, prefixIndex);
    const tsIndex = line.indexOf(" ", prefixIndex + 1);

    const { offset, length } = JSON.parse(line.slice(tsIndex + 1));

    console.log(prefix, offset, length);
  }
});
