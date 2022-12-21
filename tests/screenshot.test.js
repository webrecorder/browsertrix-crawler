import child_process from "child_process";
import fs from "fs";

// screenshot

test("ensure basic crawl run with --screenshot passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection test --url http://www.example.com/ --screenshot view --workers 2");
});

test("check that a screenshots warc file exists in the test collection", () => {
  const screenshotWarcExists = fs.existsSync("test-crawls/collections/test/archive/screenshots.warc.gz");
  expect(screenshotWarcExists).toBe(true);
});

// fullPageScreenshot

test("ensure basic crawl run with --fullPageScreenshot passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection fullpage --url http://www.example.com/ --screenshot fullPage --workers 2");
});

test("check that a screenshots warc file exists in the fullpage collection", () => {
  const screenshotWarcExists = fs.existsSync("test-crawls/collections/fullpage/archive/screenshots.warc.gz");
  expect(screenshotWarcExists).toBe(true);
});

// thumbnail

test("ensure basic crawl run with --thumbnail passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection thumbnail --url http://www.example.com/ --screenshot thumbnail --workers 2");
});

test("check that a screenshots warc file exists in the thumbnail collection", () => {
  const screenshotWarcExists = fs.existsSync("test-crawls/collections/thumbnail/archive/screenshots.warc.gz");
  expect(screenshotWarcExists).toBe(true);
});

// combination

test("ensure basic crawl run with multiple screenshot types and --generateWACZ passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection combined --url http://www.example.com/ --screenshot thumbnail,view,fullPage --generateWACZ --workers 2");
});

test("check that a screenshots warc file exists in the combined collection", () => {
  const screenshotWarcExists = fs.existsSync("test-crawls/collections/combined/archive/screenshots.warc.gz");
  expect(screenshotWarcExists).toBe(true);
});

test("check that a wacz file exists in the combined collection", () => {
  const waczExists = fs.existsSync("test-crawls/collections/combined/combined.wacz");
  expect(waczExists).toBe(true);
});
