import child_process from "child_process";
import fs from "fs";

test("ensure page limit reached", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --scopeType prefix --behaviors "" --url https://webrecorder.net/ --limit 12 --workers 2 --collection limit-test --statsFilename stats.json',
  );
});

test("check limit written to stats file is as expected", () => {
  const data = fs.readFileSync("test-crawls/stats.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(12);
  expect(dataJSON.total).toEqual(12);
  expect(dataJSON.limit.hit).toBe(true);
});
