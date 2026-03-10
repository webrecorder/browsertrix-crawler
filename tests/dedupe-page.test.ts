import { exec, execSync } from "child_process";
import fs from "fs";
import { sleep } from "./utils";

let redisId: Uint8Array;

beforeAll(() => {
  execSync("docker network create dedupe-pages");

  redisId = execSync(
    "docker run --rm --network=dedupe-pages -p 37379:6379 --name dedupe-redis -d redis",
  );
});

afterAll(async () => {
  execSync(`docker kill ${redisId}`);

  await sleep(3000);

  execSync("docker network rm dedupe-pages");
});

function runCrawl(name: string, { db = 0, limit = 3, wacz = true } = {}) {
  fs.rmSync(`./test-crawls/collections/${name}`, {
    recursive: true,
    force: true,
  });

  const crawler = exec(
    `docker run -v $PWD/test-crawls:/crawls --network=dedupe-pages -e CRAWL_ID=${name} webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit ${limit} --exclude community --collection ${name} --reportSkipped --dedupePagesMinDepth 1 --redisDedupeUrl redis://dedupe-redis:6379/${db} ${
      wacz ? "--generateWACZ" : ""
    }`,
  );

  return new Promise((resolve) => {
    crawler.on("exit", (code) => {
      resolve(code);
    });
  });
}

function loadPages(
  collName: string,
  path = "pages/extraPages.jsonl",
  filter?: (x: Record<string, string>) => boolean,
) {
  const extraPages = fs.readFileSync(
    `test-crawls/collections/${collName}/${path}`,
    "utf8",
  );

  const pageUrls = [];

  for (const page of extraPages.trim().split("\n")) {
    const parsed = JSON.parse(page);
    if (parsed.url && (!filter || filter(parsed))) {
      pageUrls.push(parsed.url);
    }
  }

  return pageUrls;
}

let firstPageUrls: string[] = [];

test("first crawl, initial 3 pages", async () => {
  const collName = "dedupe-pages-1";

  expect(await runCrawl(collName)).toBe(0);

  firstPageUrls = loadPages(collName);

  // initial seed page is in pages.jsonl + 2 remaining pages
  expect(firstPageUrls).toHaveLength(2);
});

test("first crawl, next 3 pages", async () => {
  const collName = "dedupe-pages-2";

  expect(await runCrawl(collName)).toBe(0);

  const secondPageUrls = loadPages(collName);

  // initial seed page is in pages.jsonl + 2 remaining pages
  expect(secondPageUrls).toHaveLength(2);

  // ensure pages are not in first set, totally new pages
  for (const pageUrl of firstPageUrls) {
    expect(secondPageUrls).not.toContain(pageUrl);
  }

  const skippedPages = loadPages(
    collName,
    "reports/skippedPages.jsonl",
    (entry) => entry.reason === "duplicate",
  );

  // ensure first pages are in the skipped pages list
  for (const pageUrl of firstPageUrls) {
    expect(skippedPages).toContain(pageUrl);
  }
});
