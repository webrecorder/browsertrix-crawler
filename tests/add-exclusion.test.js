import { exec } from "child_process";
import { promisify } from "util";
import Redis from "ioredis";

const execAsync = promisify(exec);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REDIS_PORT = 36382;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}/0`;
const EXCLUSION_REGEX = "webrecorder";
const TEST_QUEUE = "test:q";

test("dynamically add exclusion while crawl is running", async () => {
  console.log("Starting Docker container...");
  
  try {
    await execAsync(
      `docker run -p ${REDIS_PORT}:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection add-exclusion --url https://old.webrecorder.net/ --scopeType prefix --limit 20 --logging debug --debugAccessRedis`,
      { shell: "/bin/bash" },
    );
  } catch (error) {
    throw new Error(`Failed to start Docker container: ${error.message}`);
  }

  console.log("Waiting for Redis to start...");
  const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });

  try {
    await redis.connect();

    console.log("Monitoring Redis queue...");
    const MAX_RETRIES = 100;
    let retries = 0;

    while (retries < MAX_RETRIES) {
      if (Number(await redis.zcard(TEST_QUEUE)) > 1) {
        break;
      }
      await sleep(500);
      retries++;
    }

    if (retries === MAX_RETRIES) {
      throw new Error("Timeout waiting for Redis queue to populate");
    }

    const uids = await redis.hkeys("test:status");

    console.log("Pushing exclusion message...");
    await redis.rpush(
      `${uids[0]}:msg`,
      JSON.stringify({ type: "addExclusion", regex: EXCLUSION_REGEX }),
    );

    console.log("Asserting debug logs...");
    const { stdout } = await execAsync(`docker logs <container_id>`); // Replace with container id
    expect(stdout.indexOf("Add Exclusion") > 0).toBe(true);
    expect(stdout.indexOf("Removing excluded URL") > 0).toBe(true);
  } finally {
    console.log("Cleaning up resources...");
    await redis.quit();
  }
});
