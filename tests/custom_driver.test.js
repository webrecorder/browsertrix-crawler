import child_process from "child_process";
import fs from "fs";


test("ensure custom driver with custom selector crawls JS files as pages", async () => {
  try {
    child_process.execSync("docker run -v $PWD/tests/fixtures:/tests/fixtures -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://replayweb.page/ --collection custom-driver-1 --driver /tests/fixtures/driver-1.mjs");
  }
  catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync("test-crawls/collections/custom-driver-1/pages/pages.jsonl", "utf8");
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (!url) {
      continue;
    }
    pages.add(url);
  }

  console.log(pages);

  const expectedPages = new Set([
    "https://replayweb.page/",
    "https://replayweb.page/ui.js"
  ]);

  expect(pages).toEqual(expectedPages);

});
