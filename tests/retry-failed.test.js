import { exec, execSync } from "child_process";
import fs from "fs";
import http from "http";
import Redis from "ioredis";

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";

async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time));
}

let requests = 0;
let success = false;
let server = null;

beforeAll(() => {
  server = http.createServer((req, res) => {
    // 3 requests: 2 from browser, 1 direct fetch per attempt
    // succeed on 6th request == after 2 retries
    if (requests >= 6) {
      res.writeHead(200, {"Content-Type": "text/html"});
      res.end("<html><body>Test Data</body></html>");
      success = true;
    } else {
      res.writeHead(503, {"Content-Type": "text/html"});
      res.end("<html><body>Test Data</body></html>");
    }
    requests++;
  });

  server.listen(31501, "0.0.0.0");
});

afterAll(() => {
  server.close();
});



test("run crawl with retries for no response", async () => {
  execSync(`docker run -d -v $PWD/test-crawls:/crawls -e CRAWL_ID=test -p 36387:6379 --rm webrecorder/browsertrix-crawler crawl --url http://invalid-host-x:31501 --url https://example-com.webrecorder.net/ --limit 2 --pageExtraDelay 10 --debugAccessRedis --collection retry-fail --retries 5`);

  const redis = new Redis("redis://127.0.0.1:36387/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  let numRetries = 0;

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
    });

    while (true) {
      const res = await redis.lrange("test:f", 0, -1);
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


test("run crawl with retries for 503, enough retries to succeed", async () => {
  requests = 0;
  success = false;

  const child = exec(`docker run -v $PWD/test-crawls:/crawls --rm webrecorder/browsertrix-crawler crawl --url http://${DOCKER_HOST_NAME}:31501 --url https://example-com.webrecorder.net/ --limit 2 --collection retry-fail-2 --retries 2 --failOnInvalidStatus --failOnFailedSeed --logging stats,debug`);

  let status = 0;

  const crawlFinished = new Promise(r => resolve = r);

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function (code) {
    status = code;
    resolve();
  });

  await crawlFinished;

  expect(status).toBe(0);

  // (1 + 2) * 3 == 9 requests
  expect(requests).toBe(9);
  expect(success).toBe(true);
});


test("run crawl with retries for 503, not enough retries, fail", async () => {
  requests = 0;
  success = false;

  const child = exec(`docker run -v $PWD/test-crawls:/crawls --rm webrecorder/browsertrix-crawler crawl --url http://${DOCKER_HOST_NAME}:31501 --url https://example-com.webrecorder.net/ --limit 2 --collection retry-fail-3 --retries 1 --failOnInvalidStatus --failOnFailedSeed --logging stats,debug`);

  let status = 0;

  const crawlFinished = new Promise(r => resolve = r);

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function (code) {
    status = code;
    resolve();
  });

  await crawlFinished;

  expect(status).toBe(1);
  // (1 + 1) * 3 requests == 6 requests
  expect(requests).toBe(6);
  expect(success).toBe(false);
});


test("run crawl with retries for 503, no retries, fail", async () => {
  requests = 0;
  success = false;

  const child = exec(`docker run -v $PWD/test-crawls:/crawls --rm webrecorder/browsertrix-crawler crawl --url http://${DOCKER_HOST_NAME}:31501 --url https://example-com.webrecorder.net/ --limit 2 --collection retry-fail-4 --retries 0 --failOnInvalidStatus --failOnFailedSeed --logging stats,debug`);

  let status = 0;

  const crawlFinished = new Promise(r => resolve = r);

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function (code) {
    status = code;
    resolve();
  });

  await crawlFinished;

  expect(status).toBe(1);
  // (1) * 3 requests == 3 requests
  expect(requests).toBe(3);
  expect(success).toBe(false);
});


