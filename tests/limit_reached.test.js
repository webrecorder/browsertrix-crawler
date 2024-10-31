import fs from "fs";
import util from "util";
import { exec as execCallback, execSync } from "child_process";

const exec = util.promisify(execCallback);

test("ensure page limit reached", async () => {
  execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --scopeType prefix --behaviors "" --url https://old.webrecorder.net/ --limit 12 --workers 2 --collection limit-test --statsFilename stats.json --exclude community',
  );
});

test("check limit written to stats file is as expected", () => {
  const data = fs.readFileSync("test-crawls/stats.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(12);
  expect(dataJSON.total).toEqual(12);
  expect(dataJSON.limit.hit).toBe(true);
});

test("ensure crawl fails if failOnFailedLimit is reached", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/will404 --url https://specs.webrecorder.net --failOnInvalidStatus --failOnFailedLimit 1 --limit 10 --collection faillimitreached",
    );
  } catch (error) {
    expect(error.code).toEqual(17);
    passed = false;
  }
  expect(passed).toBe(false);
});
