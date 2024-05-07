import child_process from "child_process";
import fs from "fs";

test("test that http basic auth works", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://httpbin.org/basic-auth/foo/bar --httpBasicAuth foo:bar --collection basicauth-test --statsFilename stats.json',
  );
});

test("check that the page didn't fail", () => {
  const data = fs.readFileSync("test-crawls/stats.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(1);
  expect(dataJSON.failed).toEqual(0);
});
