import { execSync, spawn } from "child_process";
import fs from "fs";
import Redis from "ioredis";

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";

async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time));
}

test("run crawl", async () => {
  let status = 0;
  execSync(`docker run -d -v $PWD/test-crawls:/crawls -e CRAWL_ID=test -p 36387:6379 --rm webrecorder/browsertrix-crawler crawl --url http://${DOCKER_HOST_NAME}:31501 --url https://example.com/ --limit 2 --pageExtraDelay 10 --debugAccessRedis --collection retry-fail --numRetries 5`);

/*
  async function runServer() {
    console.log("Waiting to start server");
    await sleep(2000);

    console.log("Starting server");
    //spawn("../../node_modules/.bin/http-server", ["-p", "31501", "--username", "user", "--password", "pass"], {cwd: "./docs/site"});
  }
*/
  const redis = new Redis("redis://127.0.0.1:36387/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  let numRetries = 0;

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
    });

    //runServer();

    while (true) {
      const res = await redis.lrange("test:ff", 0, -1);
      if (res.length) {
        const data = JSON.parse(res);
        if (data.retry) {
          numRetries = data.retry;
          break;
        }
      }
      await sleep(20);
    }

  } catch (e) {
    console.error(e);
  } finally {
    expect(numRetries).toBe(5);
  }
});


test("check only one failed page entry is made", () => {
  expect(
    fs.existsSync("test-crawls/collections/retry-fail/pages/pages.jsonl"),
  ).toBe(true);

  expect(
    fs
      .readFileSync(
        "test-crawls/collections/retry-fail/pages/pages.jsonl",
        "utf8",
      ).trim().split("\n").length
  ).toBe(3);
});
 

