import { deepEqual, notDeepEqual } from "assert";
import child_process from "child_process";
import fs from "fs";

//const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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

test("QA policy: first 3 pages", () => {
  runCrawl("qa-policy-linear-3-pages", "--limit 3");

  const pages = readPages("qa-policy-linear-3-pages");
  expect(pages.length).toBe(3);
  deepEqual(pages, allPages.slice(0, 3));
});

test("QA policy: regex match ", () => {
  runCrawl("qa-policy-regex-match", "--qaRegex /2024/ --limit 2");

  const pages = readPages("qa-policy-regex-match");
  expect(pages.length).toBe(2);
  for (const page of pages) {
    expect(page.indexOf("/2024/")).toBeGreaterThan(-1);
  }
});

test("QA policy: random sample pageLimit 3", () => {
  runCrawl("qa-random-sample-limit", "--qaRandom --limit 3");

  const pages = readPages("qa-random-sample-limit");
  expect(pages.length).toBe(3);

  notDeepEqual(pages, allPages.slice(0, 3));
});

test("QA policy: random sample pageLimit 5", () => {
  runCrawl("qa-random-sample-limit-2", "--qaRandom --limit 5");

  const pages = readPages("qa-random-sample-limit-2");
  expect(pages.length).toBe(5);

  notDeepEqual(pages, allPages.slice(0, 5));
});
