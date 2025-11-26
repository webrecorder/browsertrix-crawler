import { execSync } from "child_process";
import fs from "node:fs";


test("run with invalid profile, fail", async () => {
  let status = 0;
  try {
    await execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection profile-0 --url https://example-com.webrecorder.net/ --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --limit 1 --profile /tests/fixtures/invalid.tar.gz",
    );
  } catch (error) {
    status = error.status;
  }

  expect(status).toBe(17);
});

test("start with no profile", async () => {
  let status = 0;
  try {
    await execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection profile-1 --url https://example-com.webrecorder.net/ --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --limit 1",
    );
  } catch (error) {
    status = error.status;
  }

  expect(status).toBe(0);
});

test("resume same crawl, but with invalid profile, not valid as no previous valid profile", async () => {
  let status = 0;
  try {
    await execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection profile-1 --url https://example-com.webrecorder.net/ --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --limit 1 --profile /tests/fixtures/invalid.tar.gz",
    );
  } catch (error) {
    status = error.status;
  }

  expect(status).toBe(17);
});


test("start with valid profile", async () => {
  let status = 0;
  try {
    await execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection profile-2 --url https://example-com.webrecorder.net/ --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --limit 1 --scopeType page --profile /tests/fixtures/sample-profile.tar.gz",
    );
  } catch (error) {
    status = error.status;
  }

  expect(status).toBe(0);

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/profile-2/pages/pages.jsonl",
    "utf8",
  );

  // crawled only one page (+ header)
  expect(crawled_pages.split("\n").length === 2);
});


test("resume same crawl, ignore invalid profile, use existing, finish crawl", async () => {
  let status = 0;
  try {
    await execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection profile-2 --url https://example-com.webrecorder.net/ --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --scopeType page --profile /tests/fixtures/invalid.tar.gz",
    );
  } catch (error) {
    status = error.status;
  }

  expect(status).toBe(0);

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/profile-1/pages/pages.jsonl",
    "utf8",
  );

  // crawled 3 pages
  expect(crawled_pages.split("\n").length === 4);
});

