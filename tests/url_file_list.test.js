import util from "util";
import { spawn, execSync, exec as execCallback } from "child_process";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import Redis from "ioredis";

const exec = util.promisify(execCallback);

const pagesFile = "test-crawls/collections/seed-file-restart-test/pages/pages.jsonl";
const extraPagesFile = "test-crawls/collections/seed-file-restart-test/pages/extraPages.jsonl";

const expectedSeedFileSeeds = [
  "https://old.webrecorder.net/about/",
  "https://specs.webrecorder.net/wacz/1.1.1/",
  "https://old.webrecorder.net/faq"
];

let proc = null;
let redisId = null;

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";
const TEST_HOST = `http://${DOCKER_HOST_NAME}:31502`;

beforeAll(() => {
  proc = spawn("../../node_modules/.bin/http-server", ["-p", "31502"], {cwd: "tests/fixtures/"});
});

afterAll(() => {
  if (proc) {
    proc.kill();
  }
});


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitContainerDone(containerId) {
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

async function killContainer(containerId) {
  try {
    execSync(`docker kill -s SIGINT ${containerId}`);
  } catch (e) {
    return;
  }

  await waitContainerDone(containerId);
}


test("check that URLs in seed-list are crawled", async () => {
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection filelisttest --urlFile /tests/fixtures/urlSeedFile.txt --timeout 90000 --scopeType page",
    );
  } catch (error) {
    console.log(error);
  }

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/filelisttest/pages/pages.jsonl",
    "utf8",
  );
  let seed_file = fs
    .readFileSync("tests/fixtures/urlSeedFile.txt", "utf8")
    .split("\n")
    .sort();

  let seed_file_list = [];
  for (var j = 0; j < seed_file.length; j++) {
    if (seed_file[j] != undefined) {
      seed_file_list.push(seed_file[j]);
    }
  }

  let foundSeedUrl = true;

  for (var i = 1; i < seed_file_list.length; i++) {
    if (crawled_pages.indexOf(seed_file_list[i]) == -1) {
      foundSeedUrl = false;
    }
  }
  expect(foundSeedUrl).toBe(true);
});


test("check that URLs in seed-list hosted at URL are crawled", async () => {
  try {
    await exec(
      `docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection onlinefilelisttest --urlFile "${TEST_HOST}/urlSeedFile.txt" --timeout 90000 --scopeType page`,
    );
  } catch (error) {
    console.log(error);
  }

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/onlinefilelisttest/pages/pages.jsonl",
    "utf8",
  );
  let seed_file = fs
    .readFileSync("tests/fixtures/urlSeedFile.txt", "utf8")
    .split("\n")
    .sort();

  let seed_file_list = [];
  for (var j = 0; j < seed_file.length; j++) {
    if (seed_file[j] != undefined) {
      seed_file_list.push(seed_file[j]);
    }
  }

  let foundSeedUrl = true;

  for (var i = 1; i < seed_file_list.length; i++) {
    if (crawled_pages.indexOf(seed_file_list[i]) == -1) {
      foundSeedUrl = false;
    }
  }
  expect(foundSeedUrl).toBe(true);
});


let savedStateFile;
let finished;

test("start crawl from seed list and then interrupt and save state when seeds have been crawled", async () => {
  let containerId = null;

  try {
    containerId = execSync(
      `docker run -d -e CRAWL_ID=seedfiletest -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection seed-file-restart-test --seedFile "${TEST_HOST}/urlSeedFile.txt" --limit 10 --behaviors "" --exclude community --scopeType page --extraHops 1 --logging stats,debug`,
      { encoding: "utf-8" },
    );
  } catch (error) {
    console.log(error);
  }

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

      if (pages.length >= 4) {
        break;
      }
    } catch (e) {
      // ignore
    }

    await sleep(500);
  }

  await killContainer(containerId);

  const savedStates = fs.readdirSync(
    "test-crawls/collections/seed-file-restart-test/crawls",
  );
  expect(savedStates.length > 0).toEqual(true);

  savedStateFile = savedStates[savedStates.length - 1];
});


test("check saved state for seed file seeds", () => {
  expect(savedStateFile).toBeTruthy();

  const savedState = fs.readFileSync(
    path.join("test-crawls/collections/seed-file-restart-test/crawls", savedStateFile),
    "utf-8",
  );

  const saved = yaml.load(savedState);

  const state = saved.state;
  finished = state.finished;

  const numDone = finished.length;
  const numQueued = state.queued.length;

  expect(!!state).toBe(true);
  expect(numDone > 0).toEqual(true);
  expect(numQueued > 0).toEqual(true);

  const seedFileDone = state.seedFileDone;
  expect(seedFileDone).toEqual(true);

  const seedFileSeeds = state.seedFileSeeds;
  expect(seedFileSeeds.length).toEqual(3);
  for (const [index, seed] of seedFileSeeds.entries()) {
    expect(seed).toEqual(expectedSeedFileSeeds[index]);
  }
});


test("check seed file seed crawl finishes successfully after resuming from saved state", async () => {
  let containerId = null;

  const port = 36383;

  try {
    containerId = execSync(
      `docker run -d -p ${port}:6379 -e CRAWL_ID=seedfiletest -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection seed-file-restart-test --debugAccessRedis --config /crawls/collections/seed-file-restart-test/crawls/${savedStateFile} --seedFile "${TEST_HOST}/urlSeedFile.txt" --limit 10 --behaviors "" --exclude community --scopeType page --extraHops 1 --logging stats,debug`,
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

    for (const url of finished) {
      const res = await redis.sismember("seedfiletest:s", url);
      expect(res).toBe(1);
    }
  } catch (e) {
    console.log(e);
  } finally {
    await waitContainerDone(containerId);
  }
});

test("ensure all pages were crawled", async () => {
  const pages = fs
    .readFileSync(pagesFile, { encoding: "utf-8" })
    .trim()
    .split("\n");

  // first line is the header
  expect(pages.length).toBe(4);

  const extraPages = fs
    .readFileSync(extraPagesFile, { encoding: "utf-8" })
    .trim()
    .split("\n");

  // first line is the header
  expect(extraPages.length).toBe(8);
})


test("ensure that seed file seeds were pulled from Redis on restart", async () => {
  const logDir = "test-crawls/collections/seed-file-restart-test/logs/";
  const logFiles = [];
  fs.readdirSync(logDir).forEach((file) => {
    if (file.endsWith(".log")) {
      logFiles.push(path.join(logDir, file));
    }
  });

  expect(logFiles.length).toBeGreaterThan(0);

  const logFile = logFiles[logFiles.length - 1];
  const log = fs.readFileSync(logFile, { encoding: "utf-8" }).trim();

  expect(
    log.indexOf(
      '"logLevel":"debug","context":"seedFile","message":"Pulled seed file seed from Redis","details":{"url":"https://old.webrecorder.net/about/"}',
    ) > 0,
  ).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"debug","context":"seedFile","message":"Pulled seed file seed from Redis","details":{"url":"https://specs.webrecorder.net/wacz/1.1.1/"}',
    ) > 0,
  ).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"debug","context":"seedFile","message":"Pulled seed file seed from Redis","details":{"url":"https://old.webrecorder.net/faq"}',
    ) > 0,
  ).toBe(true);
});
