import child_process from "child_process";
import fs from "fs";
import { Redis } from "ioredis";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test("run initial crawl with text and screenshots to prepare for QA", async () => {
  fs.rmSync("./test-crawls/qa-wr-net", { recursive: true, force: true });

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --url https://browsertrix.com/ --url https://old.webrecorder.net/contact --scopeType page --collection qa-wr-net --text to-warc --screenshot view --generateWACZ",
  );

  expect(
    fs.existsSync("test-crawls/collections/qa-wr-net/qa-wr-net.wacz"),
  ).toBe(true);
});

test("run QA comparison, with write pages to redis", async () => {
  fs.rmSync("./test-crawls/qa-wr-net-replay", { recursive: true, force: true });

  const child = child_process.exec(
    "docker run -p 36380:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/qa-wr-net/qa-wr-net.wacz --collection qa-wr-net-replay --crawlId test --qaDebugImageDiff --writePagesToRedis --debugAccessRedis --exclude contact",
  );

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
  });

  const redis = new Redis("redis://127.0.0.1:36380/0", { lazyConnect: true, retryStrategy: () => null });

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
    expect(json.comparison).toHaveProperty("resourceCounts");
    expect(json.comparison.screenshotMatch).toBe(1);
    expect(json.comparison.textMatch).toBe(1);

    expect(json.comparison.resourceCounts).toHaveProperty("crawlGood");
    expect(json.comparison.resourceCounts).toHaveProperty("crawlBad");
    expect(json.comparison.resourceCounts).toHaveProperty("replayGood");
    expect(json.comparison.resourceCounts).toHaveProperty("replayBad");

    count++;
  }

  expect(count).toBe(3);

  // wait for crawler exit
  while (!crawler_exited) {
    await sleep(100);
  }
});
