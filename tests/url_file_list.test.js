import util from "util";
import {exec as execCallback } from "child_process";
import fs from "fs";

const exec = util.promisify(execCallback);

test("check that URLs one-depth out from the seed-list are crawled", async () => {
  try {

    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection filelisttest --urlFile /tests/fixtures/urlSeedFile.txt --timeout 10000");
  }
  catch (error) {
    console.log(error);
  }

  let crawled_pages = fs.readFileSync("test-crawls/collections/filelisttest/pages/pages.jsonl", "utf8");
  let seed_file = fs.readFileSync("tests/fixtures/urlSeedFile.txt", "utf8").split("\n").sort();

  let seed_file_list = [];
  for (var j = 0; j < seed_file.length; j++) {
    if (seed_file[j] != undefined){
      seed_file_list.push(seed_file[j]);
    }
  }

  let foundSeedUrl = true;

  for (var i = 1; i < seed_file_list.length; i++) {
    if (crawled_pages.indexOf(seed_file_list[i]) == -1){
      foundSeedUrl = false;
    }
  }
  expect(foundSeedUrl).toBe(true);
});
