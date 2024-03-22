import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import Redis from "ioredis";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitContainer(containerId) {
  try {
    execSync(`docker kill -s SIGINT ${containerId}`);
  } catch (e) {
    return;
  }

  // containerId is initially the full id, but docker ps
  // only prints the short id (first 12 characters)
  containerId = containerId.slice(0, 12);

  while (true) {
    try {
      const res = execSync("docker ps -q", { encoding: "utf-8" });
      if (res.indexOf(containerId) < 0) {
        return;
      }
    } catch (e) {
      console.error(e);
    }
    await sleep(500);
  }
}

let savedStateFile;
let state;
let numDone;
let numQueued;
let finished;

test("check crawl interrupted + saved state written", async () => {
  let containerId = null;

  try {
    containerId = execSync(
      "docker run -d -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://www.webrecorder.net/ --limit 10",
      { encoding: "utf-8" },
      //wait.callback,
    );
  } catch (error) {
    console.log(error);
  }

  const pagesFile = "test-crawls/collections/int-state-test/pages/pages.jsonl";

  // remove existing pagesFile to support reentrancy
  try {
    fs.unlinkSync(pagesFile);
  } catch (e) {
    // ignore
  }

  while (true) {
    try {
      const pages = fs
        .readFileSync(pagesFile, { encoding: "utf-8" })
        .trim()
        .split("\n");

      if (pages.length >= 2) {
        break;
      }
    } catch (e) {
      // ignore
    }

    await sleep(500);
  }

  await waitContainer(containerId);

  const savedStates = fs.readdirSync(
    "test-crawls/collections/int-state-test/crawls",
  );
  expect(savedStates.length > 0).toEqual(true);

  savedStateFile = savedStates[savedStates.length - 1];
});

test("check parsing saved state + page done + queue present", () => {
  expect(savedStateFile).toBeTruthy();

  const savedState = fs.readFileSync(
    path.join("test-crawls/collections/int-state-test/crawls", savedStateFile),
    "utf-8",
  );

  const saved = yaml.load(savedState);

  expect(!!saved.state).toBe(true);
  state = saved.state;
  numDone = state.finished.length;
  numQueued = state.queued.length;

  expect(numDone > 0).toEqual(true);
  expect(numQueued > 0).toEqual(true);
  expect(numDone + numQueued).toEqual(10);

  // ensure extra seeds also set
  expect(state.extraSeeds).toEqual([
    `{"origSeedId":0,"newUrl":"https://webrecorder.net/"}`,
  ]);

  finished = state.finished;
});

test("check crawl restarted with saved state", async () => {
  let containerId = null;

  const port = 36379;

  try {
    containerId = execSync(
      `docker run -d -p ${port}:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://webrecorder.net/ --config /crawls/collections/int-state-test/crawls/${savedStateFile} --debugAccessRedis --limit 5`,
      { encoding: "utf-8" },
    );
  } catch (error) {
    console.log(error);
  }

  await sleep(2000);

  const redis = new Redis(`redis://127.0.0.1:${port}/0`, { lazyConnect: true, retryStrategy: () => null });

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
    });

    await sleep(2000);

    expect(await redis.get("test:d")).toBe(numDone + "");

    for (const url of finished) {
      const res = await redis.sismember("test:s", url);
      expect(res).toBe(1);
    }
  } catch (e) {
    console.log(e);
  } finally {
    await waitContainer(containerId);
  }
});
