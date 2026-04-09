import child_process from "child_process";
import fs from "fs";
import md5 from "md5";

//const doValidate = process.argv.filter((x) => x.startsWith('-validate'))[0];
//const testIf = (condition: string, ...args: Parameters<typeof test>) => condition ? test(...args) : test.skip(...args);

test("ensure basic crawl run with docker run passes with reportSkipped option, out of scope pages", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --generateWACZ  --collection skipped-pages --workers 2 --reportSkipped --limit 5",
  );

  child_process.execSync(
    "unzip test-crawls/collections/skipped-pages/skipped-pages.wacz -d test-crawls/collections/skipped-pages/wacz",
  );
});

// testIf(doValidate, "validate wacz with skippedPages.jsonl", () => {
//   child_process.execSync(
//     "wacz validate --file ./test-crawls/collections/skipped-pages/skipped-pages.wacz",
//   );
// });

test("ensure skippedPages.jsonl was written as expected, contains outOfScope page", () => {
  const skippedPages = fs.readFileSync(
    "test-crawls/collections/skipped-pages/reports/skippedPages.jsonl",
    "utf8",
  );

  let pageCount = 0;

  for (const line of skippedPages.trim().split("\n")) {
    const data = JSON.parse(line);
    if (data.format) {
      continue;
    }

    pageCount++;

    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("seedUrl");
    expect(data).toHaveProperty("depth");
    expect(data).toHaveProperty("reason");
    expect(data.reason).toBe("outOfScope");
    expect(data).toHaveProperty("ts");
  }

  expect(pageCount > 0).toBe(true);
});

test("ensure skippedPages.jsonl was written to wacz", () => {
  const crawlHash = md5(
    fs.readFileSync(
      "test-crawls/collections/skipped-pages/reports/skippedPages.jsonl",
      "utf8",
    ),
  );
  const waczHash = md5(
    fs.readFileSync(
      "test-crawls/collections/skipped-pages/wacz/reports/skippedPages.jsonl",
      "utf8",
    ),
  );

  expect(crawlHash).toEqual(waczHash);
});

test("check that skippedPages.jsonl file made it into WACZ datapackage.json", () => {
  expect(
    fs.existsSync(
      "test-crawls/collections/skipped-pages/wacz/datapackage.json",
    ),
  ).toBe(true);

  const data = fs.readFileSync(
    "test-crawls/collections/skipped-pages/wacz/datapackage.json",
    "utf8",
  );

  let found = false;

  const dataPackageJSON = JSON.parse(data);
  const resources = dataPackageJSON.resources;

  for (let i = 0; i < resources.length; i++) {
    const res = resources[i];
    if (res.path == "reports/skippedPages.jsonl" && res.bytes > 0) {
      found = true;
    }
  }

  expect(found).toBe(true);
});

test("ensure basic crawl run with docker run passes with reportSkipped option, pageLimit report", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --extraHops 1 --reportSkipped --collection skipped-pages-2 --limit 1",
  );
});

test("ensure skippedPages.jsonl was written as expected, contains pageLimit page", () => {
  const skippedPages = fs.readFileSync(
    "test-crawls/collections/skipped-pages-2/reports/skippedPages.jsonl",
    "utf8",
  );

  let pageCount = 0;

  for (const line of skippedPages.trim().split("\n")) {
    const data = JSON.parse(line);
    if (data.format) {
      continue;
    }

    pageCount++;

    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("seedUrl");
    expect(data).toHaveProperty("depth");
    expect(data).toHaveProperty("reason");
    expect(data.reason).toBe("pageLimit");
    expect(data).toHaveProperty("ts");
  }

  expect(pageCount > 0).toBe(true);
});

test("redirect to excluded page, crawl fails as no seeds crawled", () => {
  let failed = false;
  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://old.webrecorder.net/ --exclude https://old.webrecorder.net/ --reportSkipped --collection skipped-pages-3",
    );
  } catch (e) {
    failed = true;
  }

  expect(failed).toBe(true);
});

test("ensure skippedPages.jsonl was written as expected, contains redirectToExcluded page", () => {
  const skippedPages = fs.readFileSync(
    "test-crawls/collections/skipped-pages-3/reports/skippedPages.jsonl",
    "utf8",
  );

  let pageCount = 0;

  for (const line of skippedPages.trim().split("\n")) {
    const data = JSON.parse(line);
    if (data.format) {
      continue;
    }

    pageCount++;

    expect(data).toHaveProperty("url");
    expect(data).toHaveProperty("seedUrl");
    expect(data).toHaveProperty("depth");
    expect(data).toHaveProperty("reason");
    expect(data.reason).toBe("redirectToExcluded");
    expect(data).toHaveProperty("ts");
  }

  expect(pageCount > 0).toBe(true);
});
