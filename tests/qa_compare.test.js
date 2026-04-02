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

test("run initial crawl with text and screenshots to prepare for QA", async () => {
  fs.rmSync("./test-crawls/qa-wr-net", { recursive: true, force: true });

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --url https://archiveweb.page/ --url https://old.webrecorder.net/contact --scopeType page --collection qa-wr-net --text to-warc --screenshot view --generateWACZ",
  );

  expect(
    fs.existsSync("test-crawls/collections/qa-wr-net/qa-wr-net.wacz"),
  ).toBe(true);
});

test("run QA comparison without CSR detection, with write pages to redis", async () => {
  fs.rmSync("./test-crawls/qa-wr-net-replay", { recursive: true, force: true });

  const child = child_process.exec(
    "docker run -p 36380:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/qa-wr-net/qa-wr-net.wacz --collection qa-wr-net-replay --crawlId test --qaDebugImageDiff --writePagesToRedis --debugAccessRedis --exclude contact",
  );

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
  });
  const crawlerExitedPromise = asPromise(child);

  const redis = new Redis("redis://127.0.0.1:36380/0", {
    lazyConnect: true,
    retryStrategy: () => null,
  });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let count = 0;

  while (count < 3) {
    const res = await redis.lpop("test:pages");
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
    expect(json).toHaveProperty("ts");
    expect(json).toHaveProperty("title");
    expect(json).toHaveProperty("loadState");
    expect(json).toHaveProperty("comparison");

    expect(json.title.indexOf("contact") < 0).toBe(true);

    expect(json.comparison).toHaveProperty("screenshotMatch");
    expect(json.comparison).toHaveProperty("textMatch");
    expect(json.comparison).toHaveProperty("rawTextMatch");
    expect(json.comparison).toHaveProperty("resourceCounts");
    expect(json.comparison.screenshotMatch).toBe(1);
    expect(json.comparison.textMatch).toBe(1);
    expect(typeof json.comparison.rawTextMatch).toBe("number");

    expect(json.comparison.resourceCounts).toHaveProperty("crawlGood");
    expect(json.comparison.resourceCounts).toHaveProperty("crawlBad");
    expect(json.comparison.resourceCounts).toHaveProperty("replayGood");
    expect(json.comparison.resourceCounts).toHaveProperty("replayBad");

    count++;
  }

  expect(count).toBe(3);

  // wait for crawler exit
  await crawlerExitedPromise;
});

test("run QA comparison with CSR detection, with write pages to redis", async () => {
  fs.rmSync("./test-crawls/qa-wr-net-replay-with-csr-detection", {
    recursive: true,
    force: true,
  });

  const child = child_process.exec(
    "docker run -p 36380:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/qa-wr-net/qa-wr-net.wacz --collection qa-wr-net-replay-with-csr-detection --crawlId test-with-csr-detection --qaDebugImageDiff --qaDetectClientSideRendering --writePagesToRedis --debugAccessRedis --exclude contact",
  );

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
  });
  const crawlerExitedPromise = asPromise(child);

  const redis = new Redis("redis://127.0.0.1:36380/0", {
    lazyConnect: true,
    retryStrategy: () => null,
  });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let count = 0;

  const expectedCSRCluesValues = {
    "https://old.webrecorder.net/": {
      clues: { dom_manipulation: 4 },
      categories: { dom_manipulation: 4 },
    },
    "https://archiveweb.page/": {
      clues: { defer_script: 1 },
      categories: { modern_script_loading: 1 },
    },
    "https://old.webrecorder.net/about": { clues: {}, categories: {} },
  };

  while (count < 3) {
    const res = await redis.lpop("test-with-csr-detection:pages");
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
    expect(json).toHaveProperty("ts");
    expect(json).toHaveProperty("title");
    expect(json).toHaveProperty("loadState");
    expect(json).toHaveProperty("comparison");

    expect(json.title.indexOf("contact") < 0).toBe(true);

    expect(json.comparison).toHaveProperty("screenshotMatch");
    expect(json.comparison).toHaveProperty("textMatch");
    expect(json.comparison).toHaveProperty("rawTextMatch");
    expect(json.comparison).toHaveProperty("resourceCounts");
    expect(json.comparison.screenshotMatch).toBe(1);
    expect(json.comparison.textMatch).toBe(1);
    expect(typeof json.comparison.rawTextMatch).toBe("number");

    expect(json.comparison.resourceCounts).toHaveProperty("crawlGood");
    expect(json.comparison.resourceCounts).toHaveProperty("crawlBad");
    expect(json.comparison.resourceCounts).toHaveProperty("replayGood");
    expect(json.comparison.resourceCounts).toHaveProperty("replayBad");

    expect(json.comparison).toHaveProperty("csrClues");
    expect(json.comparison.csrClues).toHaveProperty("clues");
    expect(json.comparison.csrClues.clues).toBeInstanceOf(Object);
    expect(json.comparison.csrClues).toHaveProperty("categories");
    expect(json.comparison.csrClues.categories).toBeInstanceOf(Object);

    expect(json.comparison.csrClues).toEqual(expectedCSRCluesValues[json.url]);

    count++;
  }

  expect(count).toBe(3);

  // wait for crawler exit
  await crawlerExitedPromise;
});
