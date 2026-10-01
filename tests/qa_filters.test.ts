import { deepEqual, notDeepEqual } from "assert";
import child_process from "child_process";
import fs from "fs";

let allPages: string[] = [];

function readPageUrls(filename: string): string[] {
  try {
    const data = fs.readFileSync(filename, "utf8");
    const pageData = data.trim().split("\n");
    const pageUrls = [];
    for (const page of pageData) {
      const pageJSON = JSON.parse(page);
      if (pageJSON.url) {
        pageUrls.push(pageJSON.url);
      }
    }
    return pageUrls;
  } catch (e) {
    console.log(e);
    return [];
  }
}

function readPages(coll: string) {
  const pages = [
    ...readPageUrls(`test-crawls/collections/${coll}/pages/pages.jsonl`),
    ...readPageUrls(`test-crawls/collections/${coll}/pages/extraPages.jsonl`),
  ];
  return pages;
}

function runCrawl(coll: string, extraOpts = "") {
  fs.rmSync(`./test-crawls/collections/${coll}`, {
    recursive: true,
    force: true,
  });

  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/wr-sample-for-qa/wr-sample-for-qa.wacz --collection ${coll} --qaDebugImageDiff ${extraOpts}`,
  );

  return readPages(coll);
}

test("run initial crawl with text and screenshots to prepare for QA", async () => {
  fs.rmSync("./test-crawls/collections/wr-sample-for-qa", {
    recursive: true,
    force: true,
  });

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType prefix --limit 10 --exclude community --collection wr-sample-for-qa --text to-warc --screenshot view --generateWACZ",
  );

  expect(
    fs.existsSync(
      "test-crawls/collections/wr-sample-for-qa/wr-sample-for-qa.wacz",
    ),
  ).toBe(true);

  allPages = readPages("wr-sample-for-qa");
});

test("QA: first 3 pages", () => {
  const pages = runCrawl("qa-first-3-pages", "--limit 3");

  expect(pages.length).toBe(3);
  deepEqual(pages, allPages.slice(0, 3));
});

test("QA: regex match ", () => {
  const pages = runCrawl("qa-regex-match", "--include /2024/ --limit 2");

  expect(pages.length).toBe(2);
  for (const page of pages) {
    expect(page.indexOf("/2024/")).toBeGreaterThan(-1);
  }
});

test("QA: random sample pageLimit 3", () => {
  const pages = runCrawl("qa-random-sample-limit", "--qaRandom --limit 3");

  expect(pages.length).toBe(3);

  notDeepEqual(pages, allPages.slice(0, 3));
});

test("error: random with no page limit", () => {
  expect(() => runCrawl("qa-random-sample-error", "--qaRandom")).toThrow();
});

test("QA: random sample + regex --limit 3", () => {
  const pages = runCrawl(
    "qa-random-sample-regex",
    "--qaRandom --include 202 --include about --limit 3",
  );

  expect(pages.length).toBe(3);

  notDeepEqual(pages, allPages.slice(0, 3));

  for (const page of pages) {
    expect(page.indexOf("/202") > 0 || page.indexOf("/about") > 0).toBe(true);
  }
});
