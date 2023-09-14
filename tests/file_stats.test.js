import child_process from "child_process";
import fs from "fs";


test("ensure crawl run with docker with stats file passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --text --collection file-stats --statsFilename progress.json");

});

test("check that a stats file exists", () => {
  expect(fs.existsSync("test-crawls/progress.json")).toBe(true);
});

test("check that stats file format is correct", () => {
  const data = fs.readFileSync("test-crawls/progress.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(1);
  expect(dataJSON.total).toEqual(1);
  expect(dataJSON.pending).toEqual(0);
  expect(dataJSON.failed).toEqual(0);
  expect(dataJSON.limit.max).toEqual(0);
  expect(dataJSON.limit.hit).toBe(false);
  expect(dataJSON.pendingPages.length).toEqual(0);
});