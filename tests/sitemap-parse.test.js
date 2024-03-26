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

async function runCrawl(numExpected, url, sitemap="", limit=0, numExpectedLessThan=0, extra="") {
  const containerId = child_process.execSync(`docker run -d -p 36379:6379 -e CRAWL_ID=test webrecorder/browsertrix-crawler crawl --url ${url} --sitemap ${sitemap} --limit ${limit} --context sitemap --logging debug --debugAccessRedis ${extra}`, {encoding: "utf-8"});

  await sleep(2000);

  const redis = new Redis("redis://127.0.0.1:36379/0", { lazyConnect: true });

  let finished = 0;

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
      retryStrategy(times) {
        return times < 100 ? 1000 : null;
      },
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
    try {
      await redis.disconnect();
    } catch (e) {
      // ignore
    }
  }

  expect(finished).toBeGreaterThanOrEqual(numExpected);

  if (numExpectedLessThan) {
    expect(finished).toBeLessThanOrEqual(numExpectedLessThan);
  }
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

test("test sitemap with narrow scope, extraHops, to ensure extraHops don't apply to sitemap", async () => {
  await runCrawl(1, "https://www.mozilla.org/", true, 2000, 100, "--extraHops 1 --scopeType page");
});

