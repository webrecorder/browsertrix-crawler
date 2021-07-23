const yaml = require("js-yaml");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const md5 = require("md5");


test("ensure basic crawl run with docker run passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --text --collection wr-net --combineWARC --rolloverSize 10000 --workers 2");

  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler wacz validate --file collections/wr-net/wr-net.wacz");

  child_process.execSync("unzip test-crawls/collections/wr-net/wr-net.wacz -d test-crawls/collections/wr-net/wacz");

});

test("check that a combined warc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("test-crawls/collections/wr-net");
  var captureFound = 0;
  
  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith("_0.warc.gz")){
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});


test("check that a combined warc file is under the rolloverSize", () => {
  const warcLists = fs.readdirSync(path.join("test-crawls/collections/wr-net/wacz", "archive"));
  let rolloverSize = 0;

  function getFileSize(filename) {
    return fs.statSync(filename).size;
  }

  for (let i = 0; i < warcLists.length; i++) {
    const size = getFileSize(path.join("test-crawls/collections/wr-net/wacz/archive/", warcLists[i]));
    if (size < 10000){
      rolloverSize = 1;
    }
  }
  expect(rolloverSize).toEqual(1);
});

test("check that the pages.jsonl file exists in the collection under the pages folder", () => {
  expect(fs.existsSync("test-crawls/collections/wr-net/pages/pages.jsonl")).toBe(true);
});

test("check that the pages.jsonl file exists in the wacz under the pages folder", () => {
  expect(fs.existsSync("test-crawls/collections/wr-net/wacz/pages/pages.jsonl")).toBe(true);
});

test("check that the hash in the pages folder and in the unzipped wacz folders match", () => {
  const crawl_hash = md5(JSON.parse(fs.readFileSync("test-crawls/collections/wr-net/wacz/pages/pages.jsonl", "utf8").split("\n")[1])["text"]);
  const wacz_hash = md5(JSON.parse(fs.readFileSync("test-crawls/collections/wr-net/pages/pages.jsonl", "utf8").split("\n")[1])["text"]);
  const fixture_hash = md5(JSON.parse(fs.readFileSync("tests/fixtures/pages.jsonl", "utf8").split("\n")[1])["text"]);
  
  expect(wacz_hash).toEqual(fixture_hash);
  expect(wacz_hash).toEqual(crawl_hash);

});

