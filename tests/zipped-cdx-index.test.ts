import { execSync } from "child_process";
import fs from "fs";
import { gunzipSync } from "zlib";

const LINES_PER_BLOCK = 16;

test("ensure basic crawl run with docker run passes", async () => {
  execSync(
    `docker run -e ZIP_LINES_PER_BLOCK=${LINES_PER_BLOCK} -e ZIP_CDX_MIN_SIZE=10000 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 6 --collection zipped-cdx-merge --generateWACZ`,
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

  const gzipBuff = new Uint8Array(
    fs.readFileSync(
      "test-crawls/collections/zipped-cdx-merge/indexes/index.cdx.gz",
    ),
  );

  const blockLineCounts = [];

  let allCdxLines: string[] = [];

  for (const line of indexBuff.trim().split("\n")) {
    if (line.startsWith("!meta 0")) {
      continue;
    }
    // parse index line in format <surt> <ts> <json>, e.g. 
    // com,example)/ 20261226010203 {...}
    const prefixIndex = line.indexOf(" ");
    // surt key prefix
    const prefix = line.slice(0, prefixIndex);
    const tsIndex = line.indexOf(" ", prefixIndex + 1);
    // timestamp
    const timestamp = line.slice(prefixIndex + 1, tsIndex);

    const { offset, length } = JSON.parse(line.slice(tsIndex + 1));

    const cdxLineBuff = new TextDecoder().decode(
      gunzipSync(gzipBuff.slice(offset, offset + length)),
    );
    const cdxLines = cdxLineBuff.trim().split("\n");

    // surt and timestamp of first CDX line match index surt and timestamp
    const parts = cdxLines[0].split(" ");
    expect(parts[0]).toBe(prefix);
    expect(parts[1]).toBe(timestamp);

    allCdxLines = [...allCdxLines, ...cdxLines];

    // add to line counts
    blockLineCounts.push(cdxLines.length);
  }

  // each line count is equal to number of lines per block, except last one
  for (let i = 0; i < blockLineCounts.length - 1; i++) {
    expect(blockLineCounts[i]).toBe(LINES_PER_BLOCK);
  }

  const remainder = allCdxLines.length % LINES_PER_BLOCK;

  // should have the remainder
  expect(blockLineCounts[blockLineCounts.length - 1]).toBe(remainder);

  // ensure full sort of all cdx lines
  for (let i = 0; i < allCdxLines.length - 1; i++) {
    expect(allCdxLines[i] <= allCdxLines[i + 1]).toBe(true);
  }
});
