import { exec, ExecException } from "child_process";
import Redis from "ioredis";
import { sleep } from "./utils";

test("dynamically add exclusion while crawl is running", async () => {
  let callback:
    | ((
        error: ExecException | null,
        stdout: NonSharedBuffer,
        stderr: NonSharedBuffer,
      ) => void)
    | null = null;

  const p = new Promise<{
    error: ExecException | null;
    stdout: NonSharedBuffer;
    stderr: NonSharedBuffer;
  }>((resolve) => {
    callback = (
      error: ExecException | null,
      stdout: NonSharedBuffer,
      stderr: NonSharedBuffer,
    ) => {
      resolve({ error, stdout, stderr } as const);
    };
  });

  try {
    exec(
      "docker run -p 36382:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection add-exclusion --url https://old.webrecorder.net/ --scopeType prefix --limit 20 --logging debug --debugAccessRedis",
      { shell: "/bin/bash", encoding: "buffer" },
      callback!,
    );
  } catch (error) {
    console.log(error);
  }

  await sleep(3000);

  const redis = new Redis("redis://127.0.0.1:36382/0", {
    lazyConnect: true,
    retryStrategy: () => null,
  });

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
