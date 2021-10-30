const fs = require("fs");
const child_process = require("child_process");

test("check that when the screenshot flag is set a screenshot warc is produced", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --screenshot  --timeout 10000 --rolloverSize 10000 --workers 2");
});

test("check that a screenshotwarc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("test-crawls/collections/wr-net/screenshots");
  var captureFound = 0;

  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith(".warc.gz")){
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});
