const yaml = require("js-yaml");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");

test("check yaml config file with seed list is used", async () => {
  jest.setTimeout(30000);

  try{

    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --config /tests/fixtures/crawl-1.yaml --depth 0");
  }
  catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync("test-crawls/collections/configtest/pages/pages.jsonl", "utf8");
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (url) {
      pages.add(url);
    }
  }

  const config = yaml.load(fs.readFileSync("tests/fixtures/crawl-1.yaml", "utf8"));

  let foundAllSeeds = true; 

  for (const seed of config.seeds) {
    const url = new URL(seed).href;
    if (!pages.has(url)) {
      foundAllSeeds = false;
    }
  }
  expect(foundAllSeeds).toBe(true);

  expect(fs.existsSync("test-crawls/collections/configtest/configtest.wacz")).toBe(true);

});

test("check yaml config file will be overwritten by command line", async () => {
  jest.setTimeout(30000);

  try{

    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection configtest-2 --config /tests/fixtures/crawl-1.yaml --url https://www.example.com --timeout 20000");
  }
  catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync("test-crawls/collections/configtest-2/pages/pages.jsonl", "utf8");
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (url) {
      pages.add(url);
    }
  }

  expect(pages.has("https://www.example.com/")).toBe(true);
  expect(pages.size).toBe(1);

});
