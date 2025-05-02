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
  const command = `docker run -d -p 36381:6379 -e CRAWL_ID=test webrecorder/browsertrix-crawler crawl --url ${url} --sitemap ${sitemap} --limit ${limit} --context sitemap --logging debug --debugAccessRedis ${extra}`;
  const containerId = child_process.execSync(command, {encoding: "utf-8"});

  await sleep(3000);

  const redis = new Redis("redis://127.0.0.1:36381/0", { lazyConnect: true, retryStrategy: () => null });

  let finished = 0;

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
    });

    while (true) {
      finished = await redis.zcard("test:q");

      if (await redis.get("test:sitemapDone")) {
        break;
      }
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

  if (numExpectedLessThan) {
    expect(finished).toBeLessThanOrEqual(numExpectedLessThan);
  }
}

test("test sitemap fully finish", async () => {
  await runCrawl(3500, "https://developer.mozilla.org/", "", 0);
});

test("test sitemap with limit", async () => {
  await runCrawl(1900, "https://developer.mozilla.org/", "", 2000);
});

test("test sitemap with limit, specific URL", async () => {
  await runCrawl(1900, "https://developer.mozilla.org/", "https://developer.mozilla.org/sitemap.xml", 2000);
});

test("test sitemap with application/xml content-type", async () => {
  await runCrawl(10, "https://bitarchivist.net/", "", 0);
});

test("test sitemap with narrow scope, extraHops, to ensure out-of-scope sitemap URLs do not count as extraHops", async () => {
  await runCrawl(0, "https://www.mozilla.org/", "", 2000, 100, "--extraHops 1 --scopeType page");
});
