import {exec, execSync} from "child_process";
import fs from "fs";
import path from "path";
import { Redis } from "ioredis";
import { WARCParser } from "warcio";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


let redisId;
//let crawler1, crawler2;

beforeAll(() => {
  execSync("docker network create dedup");

  redisId = execSync("docker run --rm --network=dedup -p 37379:6379 --name dedup-redis -d redis");
});

afterAll(async () => {
  execSync(`docker kill ${redisId}`);

  await sleep(3000);

  //await Promise.allSettled([crawler1, crawler2]);

  execSync("docker network rm dedup");
});

function runCrawl(name) {
  fs.rmSync(`./test-crawls/collections/${name}`, { recursive: true, force: true });

  const crawler = exec(`docker run --rm -v $PWD/test-crawls:/crawls --network=dedup webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 4 --exclude community --collection ${name} --redisDedupUrl redis://dedup-redis:6379`);

  return new Promise((resolve) => {
    crawler.on("exit", (code) => {
      resolve(code);
    });
  });
}

function loadFirstWARC(name) {
  const archiveWarcLists = fs.readdirSync(
    `test-crawls/collections/${name}/archive`,
  );

  const warcName = path.join(`test-crawls/collections/${name}/archive`, archiveWarcLists[0]);

  const nodeStream = fs.createReadStream(warcName);

  const parser = new WARCParser(nodeStream);

  return parser; 
}

test("check revisit records written on duplicate crawl", async () => {

  expect(await runCrawl("dedup-test-orig")).toBe(0);
  expect(await runCrawl("dedup-test-dupe")).toBe(0);

  let statusCode = -1;

  let response = 0;
  let revisit = 0;

  const parserOrig = loadFirstWARC("dedup-test-orig");

  for await (const record of parserOrig) {
    if (record.warcTargetURI && record.warcTargetURI.startsWith("urn:")) {
      continue;
    }

    if (record.warcType === "response") {
      response++;
    }
  }

  const dupeOrig = loadFirstWARC("dedup-test-dupe");

  for await (const record of dupeOrig) {
    if (record.warcTargetURI && record.warcTargetURI.startsWith("urn:")) {
      continue;
    }

    if (record.warcType === "revisit") {
      revisit++;
    }
  }

  expect(response).toBeGreaterThan(0);

  // revisits should match number of responses for non urn:
  expect(response).toBe(revisit);
});


