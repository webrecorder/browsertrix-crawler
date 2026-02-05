import child_process from "child_process";

const doValidate = process.argv.filter((x) => x.startsWith('-validate'))[0];
const testIf = (condition, ...args) => condition ? test(...args) : test.skip(...args);

test("ensure basic crawl run with docker run passes with listPagesNotQueuedOption", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --generateWACZ  --collection wr-pages-not-queued --workers 2 --listPagesNotQueued --limit 5',
  );

  child_process.execSync(
    "unzip test-crawls/collections/wr-pages-not-queued/wr-pages-not-queued.wacz -d test-crawls/collections/wr-pages-not-queued/wacz",
  );
});

testIf(doValidate, "validate wacz", () => {
  child_process.execSync(
    "wacz validate --file ./test-crawls/collections/wr-pages-not-queued/wr-pages-not-queued.wacz",
  );
});

test("ensure pagesNotQueued.jsonl was written as expected", () => {
  const pagesNotQueued = fs.readFileSync(
    "test-crawls/collections/wr-pages-not-queued/pages/pagesNotQueued.jsonl",
    "utf8",
  );

  const pageCount = 0

  for (const line of pagesNotQueued.trim().split("\n")) {
    const data = JSON.parse(line);
    if (data.format) {
      continue;
    }

    pageCount++;

    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("seedUrl");
    expect(data).toHaveProperty("depth");
    expect(data).toHaveProperty("reason");
    expect(data).toHaveProperty("ts");
  }

  expect(pageCount > 0).toBe(true);

});

