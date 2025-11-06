import util from "util";
import { spawn, execSync, exec as execCallback } from "child_process";
import fs from "fs";
import Redis from "ioredis";

const exec = util.promisify(execCallback);

const pagesFile = "test-crawls/collections/seed-file-restart-test/pages/pages.jsonl";
const extraPagesFile = "test-crawls/collections/seed-file-restart-test/pages/extraPages.jsonl";

const expectedSeedFileSeeds = [
  "https://old.webrecorder.net/about/",
  "https://specs.webrecorder.net/wacz/1.1.1/",
  "https://old.webrecorder.net/faq/"
];

let proc = null;
let redisId = null;

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";
const TEST_HOST = `http://${DOCKER_HOST_NAME}:31502`;

beforeAll(() => {
  proc = spawn("../../node_modules/.bin/http-server", ["-p", "31502"], {cwd: "tests/fixtures/"});
  execSync("docker network create seedfilecrawl");
  redisId = execSync("docker run --rm --network=seedfilecrawl -p 36399:6379 --name redis -d redis");
});

afterAll(() => {
  if (proc) {
    proc.kill();
  }
  execSync(`docker kill ${redisId}`);
  execSync("docker network rm seedfilecrawl");
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


test("check that URLs in seed-list are added to Redis then interrupt crawl", async () => {
  let containerId = null;

  try {
    containerId = execSync(
      `docker run -d -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures -e CRAWL_ID=seed-file-restart-test --network=seedfilecrawl --rm webrecorder/browsertrix-crawler crawl --debugAccessRedis --redisStoreUrl redis://redis:6379 --seedFile "${TEST_HOST}/urlSeedFile.txt" --limit 10 --behaviors "" --exclude community --scopeType page --extraHops 1`,
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

      if (pages.length >= 3) {
        break;
      }
    } catch (e) {
      // ignore
    }

    await sleep(500);
  }

  await killContainer(containerId);

  const redis = new Redis("redis://127.0.0.1:36399/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  const seedFileDoneRes = await redis.get("seed-file-restart-test:sfDone");
  expect(seedFileDoneRes).toEqual("1");

  const seedFileSeeds = await redis.lrange("seed-file-restart-test:sfSeeds", 0, -1);
  expect(seedFileSeeds.length).toEqual(3);
  for (const [index, seed] of seedFileSeeds.entries()) {
    const json = JSON.parse(seed);
    // Ensure order of seeds is also kept
    expect(json.url).toEqual(expectedSeedFileSeeds[index]);
  }
});


test("check seed file seeds are pulled from Redis on crawl restart and that crawl finishes successfully", async () => {
  const res = execSync(
    `docker run -d -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures -e CRAWL_ID=seed-file-restart-test --network=seedfilecrawl --rm webrecorder/browsertrix-crawler crawl --debugAccessRedis --redisStoreUrl redis://redis:6379 --seedFile "${TEST_HOST}/urlSeedFile.txt" --limit 10 --behaviors "" --exclude community --scopeType page --extraHops 1`,
    { encoding: "utf-8" },
  );

  const log = res.toString();

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
      '"logLevel":"debug","context":"seedFile","message":"Pulled seed file seed from Redis","details":{"url":"https://old.webrecorder.net/faq/"}',
    ) > 0,
  ).toBe(true);

  const pages = fs
    .readFileSync(pagesFile, { encoding: "utf-8" })
    .trim()
    .split("\n");

  // first line is the header
  expect(pages.length).toBe(2);

  const extraPages = fs
    .readFileSync(extraPagesFile, { encoding: "utf-8" })
    .trim()
    .split("\n");

  // first line is the header
  expect(extraPages.length).toBe(10);
});
