import { exec } from "child_process";
import Redis from "ioredis";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dynamically add exclusion while crawl is running", async () => {
  let callback = null;

  const p = new Promise((resolve) => {
    callback = (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    };
  });

  try {
    exec(
      "docker run -p 36382:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection add-exclusion --url https://webrecorder.net/ --scopeType prefix --limit 20 --logging debug --debugAccessRedis",
      { shell: "/bin/bash" },
      callback,
    );
  } catch (error) {
    console.log(error);
  }

  await sleep(3000);

  const redis = new Redis("redis://127.0.0.1:36382/0", { lazyConnect: true, retryStrategy: () => null })

  await redis.connect();

  while (true) {
    if (Number(await redis.zcard("test:q")) > 1) {
      break;
    }

    await sleep(500);
  }

  const uids = await redis.hkeys("test:status");

  // exclude all pages containing 'webrecorder', should clear out the queue and end the crawl
  await redis.rpush(
    `${uids[0]}:msg`,
    JSON.stringify({ type: "addExclusion", regex: "webrecorder" }),
  );

  // ensure 'Add Exclusion is contained in the debug logs
  const { stdout } = await p;

  expect(stdout.indexOf("Add Exclusion") > 0).toBe(true);

  expect(stdout.indexOf("Removing excluded URL") > 0).toBe(true);
});

