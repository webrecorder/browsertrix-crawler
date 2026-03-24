import child_process from "child_process";
import fs from "fs";
import { Redis } from "ioredis";

/**
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 *
 * @param {child_process.ChildProcess} child
 * @returns {Promise<string>}
 */
const asPromise = (child) =>
  new Promise(function (resolve, reject) {
    child.addListener("error", reject);
    child.addListener("exit", resolve);
  });

test("run crawl with to-warc-from-raw option and verify text records", async () => {
  fs.rmSync("./test-crawls/raw-text-test", { recursive: true, force: true });

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType page --collection raw-text-test --text to-warc,to-warc-from-raw --generateCDX",
  );

  const cdxData = fs.readFileSync(
    "test-crawls/collections/raw-text-test/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  // Check that both regular text and raw text records exist
  expect(cdxData.indexOf("urn:text:https://old.webrecorder.net/") >= 0).toBe(true);
  expect(cdxData.indexOf("urn:text-from-response:https://old.webrecorder.net/") >= 0).toBe(true);
});

test("verify raw text and rendered text are different for CSR pages", async () => {
  fs.rmSync("./test-crawls/csr-test", { recursive: true, force: true });

  // Crawl a page known to have client-side rendering
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType page --collection csr-test --text to-warc,to-warc-from-raw --generateWACZ",
  );

  expect(
    fs.existsSync("test-crawls/collections/csr-test/csr-test.wacz"),
  ).toBe(true);
});

test("run QA comparison with raw text match", async () => {
  fs.rmSync("./test-crawls/qa-raw-text-replay", { recursive: true, force: true });

  const child = child_process.exec(
    "docker run -p 36381:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/raw-text-test/raw-text-test.wacz --collection qa-raw-text-replay --crawlId raw-text-test --writePagesToRedis --debugAccessRedis",
  );

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
  });
  const crawlerExitedPromise = asPromise(child);

  const redis = new Redis("redis://127.0.0.1:36381/0", {
    lazyConnect: true,
    retryStrategy: () => null,
  });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let count = 0;

  while (count < 1) {
    const res = await redis.lpop("raw-text-test:pages");
    if (!res) {
      if (crawler_exited) {
        break;
      }
      await sleep(100);
      continue;
    }
    const json = JSON.parse(res);
    expect(json).toHaveProperty("id");
    expect(json).toHaveProperty("url");
    expect(json).toHaveProperty("comparison");

    // Check that raw text comparison is present
    expect(json.comparison).toHaveProperty("rawTextMatch");
    expect(typeof json.comparison.rawTextMatch).toBe("number");
    expect(json.comparison.rawTextMatch).toBeGreaterThanOrEqual(0);
    expect(json.comparison.rawTextMatch).toBeLessThanOrEqual(1);

    // Check that both regular and raw text comparisons exist
    expect(json.comparison).toHaveProperty("textMatch");
    expect(json.comparison).toHaveProperty("screenshotMatch");

    count++;
  }

  expect(count).toBe(1);

  // wait for crawler exit
  await crawlerExitedPromise;
});

test("run QA comparison with fallback to on-the-fly raw text extraction", async () => {
  // Use the original qa-wr-net archive which doesn't have stored raw text
  fs.rmSync("./test-crawls/qa-fallback-test", { recursive: true, force: true });

  const child = child_process.exec(
    "docker run -p 36382:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/qa-wr-net/qa-wr-net.wacz --collection qa-fallback-test --crawlId fallback-test --writePagesToRedis --debugAccessRedis --exclude contact",
  );

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
  });
  const crawlerExitedPromise = asPromise(child);

  const redis = new Redis("redis://127.0.0.1:36382/0", {
    lazyConnect: true,
    retryStrategy: () => null,
  });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let count = 0;

  while (count < 3) {
    const res = await redis.lpop("fallback-test:pages");
    if (!res) {
      if (crawler_exited) {
        break;
      }
      await sleep(100);
      continue;
    }
    const json = JSON.parse(res);
    expect(json).toHaveProperty("id");
    expect(json).toHaveProperty("url");
    expect(json).toHaveProperty("comparison");

    // Check that raw text comparison works even without stored raw text
    expect(json.comparison).toHaveProperty("rawTextMatch");
    expect(typeof json.comparison.rawTextMatch).toBe("number");

    count++;
  }

  expect(count).toBe(3);

  // wait for crawler exit
  await crawlerExitedPromise;
});
