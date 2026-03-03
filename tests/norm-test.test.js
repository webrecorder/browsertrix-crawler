import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

function loadFirstWARC(name) {
  const archiveWarcLists = fs.readdirSync(
    `test-crawls/collections/${name}/archive`,
  );

  const warcName = path.join(`test-crawls/collections/${name}/archive`, archiveWarcLists[0]);

  const nodeStream = fs.createReadStream(warcName);

  const parser = new WARCParser(nodeStream);

  return parser; 
}


test("same URL with same query args, but different sort order", async () => {
  fs.rmSync("./test-crawls/collections/norm-test-1", { recursive: true, force: true });

  execSync("docker run --rm -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url 'https://example-com.webrecorder.net/?B=1&A=2' --url 'https://example-com.webrecorder.net/?A=2&B=1' --collection norm-test-1");

  const parser = loadFirstWARC("norm-test-1");

  const uris = [
    "https://example-com.webrecorder.net/?B=1&A=2",
  ];

  let count = 0;

  for await (const record of parser) {
    if (record.warcType !== "response") {
      continue;
    }

    expect(record.warcTargetURI).toBe(uris[count]);
    count++;
  }

  // no other response records, (others are revisit, resource, etc..)
  expect(count).toBe(1);
});
