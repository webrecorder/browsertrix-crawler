const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");

test("check that all urls in a file list are crawled when the filelisturl param is passed", async () => {
  jest.setTimeout(30000);

  try{

    await exec("docker-compose run crawler crawl --url http://www.example.com/ --collection filelisttest --urlFileList fixtures/urlSeedFile.txt");

  }
  catch (error) {
    console.log(error);
  }

  let crawled_pages_list = [];
  let crawled_pages = fs.readFileSync("crawls/collections/filelisttest/pages/pages.jsonl", "utf8").split("\n").sort();
  let seed_file = fs.readFileSync("tests/fixtures/urlSeedFile.txt", "utf8").split("\n").sort();

  let seed_file_list = [];
  console.log(seed_file);
  for (var j = 0; j < seed_file.length; j++) {
    console.log(seed_file[j]);
    if (seed_file[j] != undefined){
      seed_file_list.push(seed_file[j]);
    }
  }

  for (var i = 1; i < crawled_pages.length; i++) {
    if (crawled_pages[j] != undefined){
      crawled_pages_list.push(JSON.parse(crawled_pages[i])["url"]);
    }
  }
  console.log(crawled_pages_list);
  console.log(seed_file_list);
  expect(crawled_pages_list.sort()).toBe(seed_file_list);
});