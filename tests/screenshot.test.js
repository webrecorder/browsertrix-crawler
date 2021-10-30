const child_process = require("child_process");
const fs = require("fs");

test("ensure basic crawl run with screenshot run passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection test --url http://www.example.com/ --screenshot --workers 2");
});

test("check that a screenshots warc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("test-crawls/collections/test/screenshots/");
  var captureFound = 0;

  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith(".warc.gz")){
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});
