import child_process from "child_process";
import fs from "fs";


test("ensure --overwrite with existing collection results in a successful crawl", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --collection overwrite");

  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --collection overwrite --overwrite");
});

test("check that the pages.jsonl file exists in the collection under the pages folder", () => {
  expect(fs.existsSync("test-crawls/collections/overwrite/pages/pages.jsonl")).toBe(true);
});

test("check that the WACZ file exists in the collection", () => {
  expect(fs.existsSync("test-crawls/collections/overwrite/pages/pages.jsonl")).toBe(true);
});

//-----------

test("ensure --overwrite results in a successful crawl even if collection didn't exist", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --collection overwrite-nothing --overwrite");
});

test("check that the pages.jsonl file exists in the collection under the pages folder", () => {
  expect(fs.existsSync("test-crawls/collections/overwrite-nothing/pages/pages.jsonl")).toBe(true);
});

test("check that the WACZ file exists in the collection", () => {
  expect(fs.existsSync("test-crawls/collections/overwrite-nothing/pages/pages.jsonl")).toBe(true);
});
