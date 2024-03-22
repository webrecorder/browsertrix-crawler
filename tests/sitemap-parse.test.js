import child_process from "child_process";
import Redis from "ioredis";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitContainer(containerId) {
  try {
    child_process.execSync(`docker kill -s SIGINT ${containerId}`);
  } catch (e) {
    return;
  }

  // containerId is initially the full id, but docker ps
  // only prints the short id (first 12 characters)
  containerId = containerId.slice(0, 12);

  while (true) {
    try {
      const res = child_process.execSync("docker ps -q", { encoding: "utf-8" });
      if (res.indexOf(containerId) < 0) {
        return;
      }
    } catch (e) {
      console.error(e);
    }
    await sleep(500);
  }
}

async function runCrawl(numExpected, url, sitemap="", limit=0) {
  const containerId = child_process.execSync(`docker run -d -p 36381:6379 -e CRAWL_ID=test webrecorder/browsertrix-crawler crawl --url ${url} --sitemap ${sitemap} --limit ${limit} --context sitemap --logging debug --debugAccessRedis`, {encoding: "utf-8"});

  await sleep(3000);

  const redis = new Redis("redis://127.0.0.1:36381/0", { lazyConnect: true, retryStrategy: () => null });

  let finished = 0;

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
    });

    while (true) {
      finished = await redis.zcard("test:q");

      if (finished >= numExpected) {
        break;
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await waitContainer(containerId);
  }

  expect(finished).toBeGreaterThanOrEqual(numExpected);
}

test("test sitemap fully finish", async () => {
  await runCrawl(8036, "https://www.mozilla.org/", "", 0);
});

test("test sitemap with limit", async () => {
  await runCrawl(1900, "https://www.mozilla.org/", "", 2000);
});

test("test sitemap with limit, specific URL", async () => {
  await runCrawl(1900, "https://www.mozilla.org/", "https://www.mozilla.org/sitemap.xml", 2000);
});
