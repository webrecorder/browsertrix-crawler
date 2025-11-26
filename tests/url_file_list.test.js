import util from "util";
import { spawn, exec as execCallback } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const exec = util.promisify(execCallback);

let proc = null;

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";
const TEST_HOST = `http://${DOCKER_HOST_NAME}:31502`;

const fixtures = path.join("tests", "fixtures");
const seedFileCopy = path.join(fixtures, "seedFileCopy.txt");

beforeAll(() => {
  fs.copyFileSync(path.join(fixtures, "urlSeedFile.txt"), seedFileCopy);

  proc = spawn("../../node_modules/.bin/http-server", ["-p", "31502"], {cwd: fixtures});
});

afterAll(() => {
  if (proc) {
    proc.kill();
    proc = null;
  }
  fs.unlinkSync(seedFileCopy);
});


function verifyAllSeedsCrawled(collName, hasDownload) {
  let crawled_pages = fs.readFileSync(
    `test-crawls/collections/${collName}/pages/pages.jsonl`,
    "utf8",
  );

  const seedFile = hasDownload ? `test-crawls/collections/${collName}/downloads/seedFileCopy.txt` : "tests/fixtures/urlSeedFile.txt";
  let seed_file = fs
    .readFileSync(seedFile, "utf8")
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
}



test("check that URLs in seed-list are crawled", async () => {
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection filelisttest --urlFile /tests/fixtures/urlSeedFile.txt --timeout 90000 --scopeType page",
    );
  } catch (error) {
    console.log(error);
  }

  verifyAllSeedsCrawled("filelisttest", false);
});


test("check that URLs in seed-list hosted at URL are crawled", async () => {
  try {
    await exec(
      `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection onlinefilelisttest --urlFile "${TEST_HOST}/seedFileCopy.txt" --timeout 90000 --scopeType page`,
    );
  } catch (error) {
    console.log(error);
  }

  verifyAllSeedsCrawled("onlinefilelisttest", true);

});


test("start crawl, interrupt, remove seed file, and ensure all seed URLs are crawled", async () => {
  try {
    await exec(
      `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection seed-file-removed --urlFile "${TEST_HOST}/seedFileCopy.txt" --timeout 90000 --scopeType page --limit 1`,
    );
  } catch (error) {
    console.log(error);
  }

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/seed-file-removed/pages/pages.jsonl",
    "utf8",
  );

  expect(crawled_pages.split("\n").length === 2);

  try {
    // move file so server returns 404
    fs.renameSync(seedFileCopy, seedFileCopy + ".bak");

    // server no longer up
    try {
      const res = await fetch("http://localhost:31502/");
      expect(res.status).toBe(404);
    } catch (e) {
      // ignore
    }

    // restart crawl, but with invalid seed list now
    await exec(
      `docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection seed-file-removed --urlFile "${TEST_HOST}/seedFileCopy.txt" --timeout 90000 --scopeType page`,
    );
  } catch (error) {
    console.log(error);
  } finally {
    // move back
    fs.renameSync(seedFileCopy + ".bak", seedFileCopy);
  }


  verifyAllSeedsCrawled("seed-file-removed", true);
});


test("start crawl, interrupt, stop seed file server, and ensure all seed URLs are crawled", async () => {
  try {
    await exec(
      `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection seed-file-server-gone --urlFile "${TEST_HOST}/seedFileCopy.txt" --timeout 90000 --scopeType page --limit 1`,
    );
  } catch (error) {
    console.log(error);
  }

  let crawled_pages = fs.readFileSync(
    "test-crawls/collections/seed-file-server-gone/pages/pages.jsonl",
    "utf8",
  );

  expect(crawled_pages.split("\n").length === 2);

  // kill server that serves the seed list
  proc.kill();

  // server no longer up
  await expect(() => fetch("http://localhost:31502/")).rejects.toThrow("fetch failed");

  // restart crawl, but with invalid seed list now
  try {
    await exec(
      `docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection seed-file-server-gone --urlFile "${TEST_HOST}/seedFileCopy.txt" --timeout 90000 --scopeType page`,
    );
  } catch (error) {
    console.log(error);
  }

  verifyAllSeedsCrawled("seed-file-server-gone", true);
});
