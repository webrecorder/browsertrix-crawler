import child_process from "child_process";
import fs from "fs";
import md5 from "md5";

const doValidate = process.argv.filter((x) => x.startsWith('-validate'))[0];
const testIf = (condition, ...args) => condition ? test(...args) : test.skip(...args);

test("ensure basic crawl run with docker run passes with listNotQueued option", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --generateWACZ  --collection wr-not-queued --workers 2 --listNotQueued --limit 5',
  );

  child_process.execSync(
    "unzip test-crawls/collections/wr-not-queued/wr-not-queued.wacz -d test-crawls/collections/wr-not-queued/wacz",
  );
});

testIf(doValidate, "validate wacz with notQueued.jsonl", () => {
  child_process.execSync(
    "wacz validate --file ./test-crawls/collections/wr-not-queued/wr-not-queued.wacz",
  );
});

test("ensure notQueued.jsonl was written as expected", () => {
  const notQueued = fs.readFileSync(
    "test-crawls/collections/wr-not-queued/reports/notQueued.jsonl",
    "utf8",
  );

  let pageCount = 0

  for (const line of notQueued.trim().split("\n")) {
    const data = JSON.parse(line);
    if (data.format) {
      continue;
    }

    pageCount++;

    const validReasons = ["outOfScope", "pageLimit", "robotsTxt"];

    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("seedUrl");
    expect(data).toHaveProperty("depth");
    expect(data).toHaveProperty("reason");
    expect(validReasons.includes(data.reason)).toBe(true);
    expect(data).toHaveProperty("ts");
  }

  expect(pageCount > 0).toBe(true);

});

test("ensure notQueued.jsonl was written to wacz", () => {
  const crawlHash = md5(
    fs.readFileSync(
        "test-crawls/collections/wr-not-queued/reports/notQueued.jsonl",
        "utf8",
      )
  );
  const waczHash = md5(
    fs.readFileSync(
        "test-crawls/collections/wr-not-queued/wacz/reports/notQueued.jsonl",
        "utf8",
      ) 
  );

  expect(crawlHash).toEqual(waczHash);
});

test("check that notQueued.jsonl file made it into WACZ datapackage.json", () => {
  expect(
    fs.existsSync("test-crawls/collections/wr-not-queued/wacz/datapackage.json"),
  ).toBe(true);

  const data = fs.readFileSync(
    "test-crawls/collections/wr-not-queued/wacz/datapackage.json",
    "utf8",
  );

  let found = false;

  const dataPackageJSON = JSON.parse(data);
  const resources = dataPackageJSON.resources;

  for (let i = 0; i < resources.length; i++) {
    const res = resources[i];
    if (res.path == "reports/notQueued.jsonl" && res.bytes > 0) {
      found = true;
    }
  }

  expect(found).toBe(true);
});
