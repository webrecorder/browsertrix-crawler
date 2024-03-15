import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import Redis from "ioredis";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitContainer(containerId) {
  execSync(`docker kill -s SIGINT ${containerId}`);

  while (true) {
    const res = execSync("docker ps -q", { encoding: "utf-8" });
    if (res.indexOf(containerId) < 0) {
      return;
    }
    await sleep(500);
  }
}

var savedStateFile;
var state;
var numDone;
var numQueued;
var finished;
var redis;

test("check crawl interrupted + saved state written", async () => {
  let containerId = null;

  try {
    containerId = execSync(
      "docker run -d -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://iana.org/ --limit 10",
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
    `{"origSeedId":0,"newUrl":"https://www.iana.org/"}`,
  ]);

  finished = state.finished;
});

test("check crawl restarted with saved state", async () => {
  let containerId = null;

  //const wait = waitForProcess();

  try {
    containerId = execSync(
      `docker run -d -p 36379:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://webrecorder.net/ --config /crawls/collections/int-state-test/crawls/${savedStateFile} --debugAccessRedis --limit 5`,
      { encoding: "utf-8" },
      //{ shell: "/bin/bash" },
      //wait.callback,
    );
  } catch (error) {
    console.log(error);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  redis = new Redis("redis://127.0.0.1:36379/0", { lazyConnect: true });

  try {
    await redis.connect({
      maxRetriesPerRequest: 100,
      retryStrategy(times) {
        return times < 100 ? 1000 : null;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

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

  await redis.disconnect();
});
