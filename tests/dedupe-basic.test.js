import {exec, execSync} from "child_process";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { WARCParser } from "warcio";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


let redisId;
let numResponses = 0;

beforeAll(() => {
  execSync("docker network create dedupe");

  redisId = execSync("docker run --rm --network=dedupe -p 37379:6379 --name dedupe-redis -d redis");
});

afterAll(async () => {
  execSync(`docker kill ${redisId}`);

  await sleep(3000);

  //await Promise.allSettled([crawler1, crawler2]);

  execSync("docker network rm dedupe");
});

function runCrawl(name, db="0") {
  fs.rmSync(`./test-crawls/collections/${name}`, { recursive: true, force: true });

  const crawler = exec(`docker run --rm -v $PWD/test-crawls:/crawls --network=dedupe -e CRAWL_ID=${name} webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 4 --exclude community --collection ${name} --redisDedupeUrl redis://dedupe-redis:6379/${db} --generateWACZ`);

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

function loadDataPackageRelated(name) {
  execSync(
    `unzip test-crawls/collections/${name}/${name}.wacz -d test-crawls/collections/${name}/wacz`,
  );

  const data = fs.readFileSync(
    `test-crawls/collections/${name}/wacz/datapackage.json`,
    "utf8",
  );
  const dataPackageJSON = JSON.parse(data);
  return dataPackageJSON.relation;
}


test("check revisit records written on duplicate crawl", async () => {

  expect(await runCrawl("dedupe-test-orig")).toBe(0);
  expect(await runCrawl("dedupe-test-dupe")).toBe(0);

  let statusCode = -1;

  let response = 0;
  let revisit = 0;

  const parserOrig = loadFirstWARC("dedupe-test-orig");

  for await (const record of parserOrig) {
    if (record.warcTargetURI && record.warcTargetURI.startsWith("urn:")) {
      continue;
    }

    if (record.warcType === "response") {
      response++;
    }
  }

  const dupeOrig = loadFirstWARC("dedupe-test-dupe");

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

  numResponses = response;
});


test("import index and crawl dupe", async () => {
  
  execSync(`docker run --rm -v $PWD/test-crawls:/crawls --network=dedupe webrecorder/browsertrix-crawler indexer --sourceUrl /crawls/collections/dedupe-test-orig/dedupe-test-orig.wacz --sourceCrawlId dedupe-test-orig --redisDedupeUrl redis://dedupe-redis:6379/1`);

  const redis = new Redis("redis://127.0.0.1:37379/1", { lazyConnect: true, retryStrategy: () => null });

  await redis.connect({maxRetriesPerRequest: 50});

  expect(await redis.hlen("alldupes")).toBe(numResponses);
});


test("imported crawl dupe matches previous dupe count", async () => {
  expect(await runCrawl("dedupe-test-dupe-2", 1)).toBe(0);

  const dupeOrig = loadFirstWARC("dedupe-test-dupe-2");

  let revisit = 0;

  for await (const record of dupeOrig) {
    if (record.warcTargetURI && record.warcTargetURI.startsWith("urn:")) {
      continue;
    }

    if (record.warcType === "revisit") {
      revisit++;
    }
  }

  // matches same number of revisits as original
  expect(revisit).toBe(numResponses);
});

test("test requires in datapackage.json of wacz deduped against previous crawl", () => {
  const res1 = loadDataPackageRelated("dedupe-test-dupe");

  expect(res1.requires.length).toBe(1);
  const entry = res1.requires[0];
  expect(entry.crawlId).toBe("dedupe-test-orig");
  expect(entry.filename).toBe("dedupe-test-orig.wacz");
  expect(entry.size).toBeDefined();
  expect(entry.hash).toBeDefined();
});

test("test requires in datapackage.json of wacz deduped against import from wacz", () => {
  const res2 = loadDataPackageRelated("dedupe-test-dupe-2");
  expect(res2.requires.length).toBe(1);
  const entry2 = res2.requires[0];
  expect(entry2.crawlId).toBe("dedupe-test-orig");
  expect(entry2.filename).toBe("dedupe-test-orig.wacz");
  // undefined as importing from single WACZ and not computing
  expect(entry2.size).toBeUndefined();
  expect(entry2.hash).toBeUndefined();
});


