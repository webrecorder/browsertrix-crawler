import fs from "fs";
import child_process, { ExecException } from "child_process";

test("check that urn:domsnapshot are records are written to WARC", async () => {
  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection dom-snapshot --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --scopeType page --generateCDX --domSnapshot",
    );
  } catch (error) {
    //console.log(new TextDecoder().decode(error));
    console.log((error as ExecException).stderr);
  }

  const data = fs.readFileSync(
    "test-crawls/collections/dom-snapshot/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  expect(data.indexOf("urn:domsnapshot:https://old.webrecorder.net/") > 0).toBe(
    true,
  );

  expect(
    data.indexOf("urn:domsnapshot:https://old.webrecorder.net/about") > 0,
  ).toBe(true);
});
