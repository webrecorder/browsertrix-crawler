import fs from "fs";
import child_process from "child_process";

test("ensure URLs with same query args but in different order considered same URL", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls --rm webrecorder/browsertrix-crawler crawl --url 'https://example-com.webrecorder.net/?A=1&B=2' --url 'https://example-com.webrecorder.net/?B=2&A=1' --collection url-norm-1 --scopeType page");

  // url is normalized, only 1 URL is crawled
  // check pages.jsonl for 1 URL (+ 1 header)
  expect(fs.readFileSync(
    "test-crawls/collections/url-norm-1/pages/pages.jsonl", "utf8",
      )
      .trim()
      .split("\n").length).toBe(1 + 1);
});

