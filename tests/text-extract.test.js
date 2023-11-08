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
