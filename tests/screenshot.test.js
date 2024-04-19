import child_process from "child_process";
import fs from "fs";

// screenshot

function screenshotWarcExists(name) {
  const warcList = fs.readdirSync(`test-crawls/collections/${name}/archive/`);

  for (const warc of warcList) {
    if (warc.startsWith("screenshots-")) {
      return true;
    }
  }

  return false;
}


test("ensure basic crawl run with --screenshot passes", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection test-with-screenshots --url http://www.example.com/ --screenshot view --workers 2",
  );
});

test("check that a screenshots warc file exists in the test collection", () => {
  expect(screenshotWarcExists("test-with-screenshots")).toBe(true);
});

// fullPageScreenshot

test("ensure basic crawl run with --fullPageScreenshot passes", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection fullpage --url http://www.example.com/ --screenshot fullPage --workers 2",
  );
});

test("check that a screenshots warc file exists in the fullpage collection", () => {
  expect(screenshotWarcExists("fullpage")).toBe(true);
});

// thumbnail

test("ensure basic crawl run with --thumbnail passes", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection thumbnail --url http://www.example.com/ --screenshot thumbnail --workers 2",
  );
});

test("check that a screenshots warc file exists in the thumbnail collection", () => {
  expect(screenshotWarcExists("thumbnail")).toBe(true);
});

// combination

test("ensure basic crawl run with multiple screenshot types and --generateWACZ passes", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection combined --url http://www.example.com/ --screenshot thumbnail,view,fullPage --generateWACZ --workers 2",
  );
});

test("check that a screenshots warc file exists in the combined collection", () => {
  expect(screenshotWarcExists("combined")).toBe(true);
});

test("check that a wacz file exists in the combined collection", () => {
  const waczExists = fs.existsSync(
    "test-crawls/collections/combined/combined.wacz",
  );
  expect(waczExists).toBe(true);
});
