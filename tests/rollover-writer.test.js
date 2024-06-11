import child_process from "child_process";
import fs from "fs";

test("set rollover to 500K and ensure individual WARCs rollover, including screenshots", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --limit 5 --collection rollover-500K --rolloverSize 500000 --screenshot view"
  );

  const warcLists = fs.readdirSync("test-crawls/collections/rollover-500K/archive");

  let main = 0;
  let screenshots = 0;

  for (const name of warcLists) {
    if (name.startsWith("rec-")) {
      main++;
    } else if (name.startsWith("screenshots-")) {
      screenshots++;
    }
  }

  // expect at least 6 main WARCs
  expect(main).toBeGreaterThan(5);

  // expect at least 2 screenshot WARCs
  expect(screenshots).toBeGreaterThan(1);

});
