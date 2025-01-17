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
  let containerId = null;

  try {
    // Start Docker container and capture its ID
    const { stdout: containerStartOutput } = await execAsync(
      `docker run -d -p ${REDIS_PORT}:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection add-exclusion --url https://old.webrecorder.net/ --scopeType prefix --limit 20 --logging debug --debugAccessRedis`,
      { shell: "/bin/bash" }
    );
    containerId = containerStartOutput.trim(); // Capture the container ID
    console.log(`Docker container started with ID: ${containerId}`);

    console.log("Waiting for Redis to start...");
    const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });

    let retries = 0;
    const MAX_RETRIES = 20;

    while (retries < MAX_RETRIES) {
      try {
        await redis.connect();
        if (redis.status === "ready") break;
      } catch {
        // Retry on connection failure
        retries++;
        console.log(`Retry ${retries}/${MAX_RETRIES}`);
        await sleep(1000);
      }
    }

    if (redis.status !== "ready") {
      throw new Error("Failed to connect to Redis.");
    }

    console.log("Monitoring Redis queue...");
    retries = 0;

    while (retries < MAX_RETRIES) {
      if (Number(await redis.zcard(TEST_QUEUE)) > 1) break;
      await sleep(500);
      retries++;
    }

    if (retries === MAX_RETRIES) {
      throw new Error("Timeout waiting for Redis queue to populate.");
    }

    const uids = await redis.hkeys("test:status");
    console.log("Pushing exclusion message...");
    await redis.rpush(
      `${uids[0]}:msg`,
      JSON.stringify({ type: "addExclusion", regex: EXCLUSION_REGEX })
    );

    console.log("Fetching and asserting logs...");
    const { stdout: logs } = await execAsync(`docker logs ${containerId}`);
    expect(logs.indexOf("Add Exclusion") > 0).toBe(true);
    expect(logs.indexOf("Removing excluded URL") > 0).toBe(true);

    console.log("Test completed successfully.");
  } catch (error) {
    console.error(`Error during test: ${error.message}`);
    throw error;
  } finally {
    console.log("Cleaning up resources...");
    if (containerId) {
      await execAsync(`docker stop ${containerId}`);
      await execAsync(`docker rm ${containerId}`);
      console.log(`Docker container ${containerId} stopped and removed.`);
    }
  }
});
