import child_process from "child_process";
import fs from "fs";

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

testIf(doValidate, "validate wacz", () => {
  child_process.execSync(
    "wacz validate --file ./test-crawls/collections/wr-not-queued/wr-not-queued.wacz",
  );
});

test("ensure notQueued.jsonl was written as expected", () => {
  const notQueued = fs.readFileSync(
    "test-crawls/collections/wr-not-queued/reports/notQueued.jsonl",
    "utf8",
  );

  const pageCount = 0

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

