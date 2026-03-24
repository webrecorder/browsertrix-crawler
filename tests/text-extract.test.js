import fs from "fs";
import child_process from "child_process";

test("check that urn:text and urn:textfinal records are written to WARC", async () => {
  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection text-extract --url https://www.nytimes.com/ --scopeType page --generateCDX --text to-warc,final-to-warc",
    );
  } catch (error) {
    //console.log(new TextDecoder().decode(error));
    console.log(error.stderr);
  }

  const data = fs.readFileSync(
    "test-crawls/collections/text-extract/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  expect(data.indexOf("urn:text:https://www.nytimes.com/") > 0).toBe(true);

  expect(data.indexOf("urn:textFinal:https://www.nytimes.com/") > 0).toBe(true);
});

test("check that raw text extraction creates urn:text-from-response records", async () => {
  fs.rmSync("./test-crawls/raw-text-crawl", { recursive: true, force: true });
  
  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection raw-text-crawl --url https://example.com/ --scopeType page --generateCDX --text to-warc,to-warc-from-raw",
    );
  } catch (error) {
    console.log(error.stderr);
  }

  const data = fs.readFileSync(
    "test-crawls/collections/raw-text-crawl/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  // Regular rendered text record
  expect(data.indexOf("urn:text:https://example.com/") >= 0).toBe(true);
  
  // Raw response text record
  expect(data.indexOf("urn:text-from-response:https://example.com/") >= 0).toBe(true);
});
