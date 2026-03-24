import child_process from "child_process";
import fs from "fs";

test("ensure custom driver creates PDF", async () => {
  try {
    child_process.execSync(
      "docker run -v $PWD/tests/fixtures:/tests/fixtures -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --collection custom-driver-1 --driver /tests/fixtures/driver-1.mjs --limit 1",
    );
  } catch (error) {
    console.log(error);
  }

  const pdfs = fs.readdirSync("test-crawls/collections/custom-driver-1").filter(x => x.endsWith(".pdf"));
  expect(pdfs.length).toBe(1);
});
