import child_process from "child_process";
import fs from "fs";

test("ensure custom driver with custom selector crawls JS files as pages", async () => {
  try {
    child_process.execSync(
      "docker run -v $PWD/tests/fixtures:/tests/fixtures -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --collection custom-driver-1 --driver /tests/fixtures/driver-1.mjs",
    );
  } catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync(
    "test-crawls/collections/custom-driver-1/pages/pages.jsonl",
    "utf8",
  );
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (!url) {
      continue;
    }
    pages.add(url);
  }

  const crawledExtraPages = fs.readFileSync(
    "test-crawls/collections/custom-driver-1/pages/extraPages.jsonl",
    "utf8",
  );
  const extraPages = new Set();

  for (const line of crawledExtraPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (!url) {
      continue;
    }
    extraPages.add(url);
  }

  const expectedPages = new Set([
    "https://www.iana.org/",
  ]);

  const expectedExtraPages = new Set([
    "https://www.iana.org/_js/jquery.js",
    "https://www.iana.org/_js/iana.js",
  ]);

  expect(pages).toEqual(expectedPages);
  expect(extraPages).toEqual(expectedExtraPages);
});
