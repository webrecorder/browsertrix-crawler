import fs from "fs";

import util from "util";
import {exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);



test("check that URLs are crawled 2 extra hops beyond depth", async () => {
  try {
    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection extra-hops-beyond --extraHops 2 --url https://example.com/ --limit 7");
  }
  catch (error) {
    console.log(error);
  }

  const crawled_pages = fs.readFileSync("test-crawls/collections/extra-hops-beyond/pages/pages.jsonl", "utf8");

  const expectedPages = [
    "https://example.com/",
    "https://www.iana.org/domains/example",
    "http://www.iana.org/",
    "http://www.iana.org/domains",
    "http://www.iana.org/protocols",
    "http://www.iana.org/numbers",
    "http://www.iana.org/about",
  ];

  for (const page of crawled_pages.trim().split("\n")) {
    const url = JSON.parse(page).url;
    if (!url) {
      continue;
    }
    expect(expectedPages.indexOf(url) >= 0).toBe(true);
  }
});
