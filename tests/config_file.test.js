import fs from "fs";
import yaml from "js-yaml";

import util from "util";
import {exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);


test("check yaml config file with seed list is used", async () => {
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
  try{

    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection configtest-2 --config /tests/fixtures/crawl-1.yaml --url https://specs.webrecorder.net/ --scopeType page --timeout 20000");
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

  expect(pages.has("https://specs.webrecorder.net/")).toBe(true);
  expect(pages.size).toBe(1);

});
