import {exec, execSync, spawnSync} from "child_process";
import fs from "fs";
import { Redis } from "ioredis";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


let redisId;
let crawler1, crawler2;

beforeAll(() => {
  fs.rmSync("./test-crawls/collections/shared-crawler-1", { recursive: true, force: true });
  fs.rmSync("./test-crawls/collections/shared-crawler-2", { recursive: true, force: true });

  execSync("docker network create crawl");

  redisId = execSync("docker run --rm --network=crawl -p 37379:6379 --name redis -d redis");

  crawler1 = runCrawl("crawler-1");
  crawler2 = runCrawl("crawler-2");
});

afterAll(async () => {
  execSync(`docker kill ${redisId}`);

  spawnSync(`docker wait ${redisId}`);

  await Promise.allSettled([crawler1, crawler2]);

  execSync("docker network rm crawl");
});

function runCrawl(name) {
  const crawler = exec(`docker run --rm -v $PWD/test-crawls:/crawls --network=crawl --hostname=${name} webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 4 --exclude community --collection shared-${name} --crawlId testcrawl --redisStoreUrl redis://redis:6379`);

  return new Promise((resolve) => {
    crawler.on("exit", (code) => {
      resolve(code);
    });
  });
}

test("run crawlers with external redis", async () => {
  const redis = new Redis("redis://127.0.0.1:37379/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let count = 0;

  while (true) {
    try {
      const values = await redis.hgetall("testcrawl:status");
      expect(values["crawler-1"]).toBe("running");
      expect(values["crawler-2"]).toBe("running");
      break;
    } catch (e) {
      if (count++ < 5) {
        await sleep(1000);
        continue;
      }

      throw e;
    }
  }

});


test("finish crawls successfully", async () => {
  const res = await Promise.allSettled([crawler1, crawler2]);
  expect(res[0].value).toBe(0);
  expect(res[1].value).toBe(0);
}, 180000);

test("ensure correct number of pages", () => {

  expect(
    fs.existsSync("test-crawls/collections/shared-crawler-1/pages/pages.jsonl"),
  ).toBe(true);

  expect(
    fs.existsSync("test-crawls/collections/shared-crawler-2/pages/pages.jsonl"),
  ).toBe(true);

  const pages_1 = fs
    .readFileSync(
      "test-crawls/collections/shared-crawler-1/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  const pages_2 = fs
    .readFileSync(
      "test-crawls/collections/shared-crawler-2/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  // add 2 for heading in each file
  expect(pages_1.length + pages_2.length).toBe(1 + 2);
});

test("ensure correct number of extraPages", () => {

  expect(
    fs.existsSync("test-crawls/collections/shared-crawler-1/pages/extraPages.jsonl"),
  ).toBe(true);

  expect(
    fs.existsSync("test-crawls/collections/shared-crawler-2/pages/extraPages.jsonl"),
  ).toBe(true);

  const pages_1 = fs
    .readFileSync(
      "test-crawls/collections/shared-crawler-1/pages/extraPages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  const pages_2 = fs
    .readFileSync(
      "test-crawls/collections/shared-crawler-2/pages/extraPages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  // add 2 for heading in each file
  expect(pages_1.length + pages_2.length).toBe(3 + 2);
});
