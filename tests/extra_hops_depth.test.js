import fs from "fs";

import util from "util";
import {exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

const extraHopsTimeout = 180000;


test("check that URLs are crawled 2 extra hops beyond depth", async () => {
  try {
    await exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection extra-hops-beyond --extraHops 2 --url https://webrecorder.net/ --limit 7");
  }
  catch (error) {
    console.log(error);
  }

  const crawled_pages = fs.readFileSync("test-crawls/collections/extra-hops-beyond/pages/pages.jsonl", "utf8");

  const expectedPages = [
    "https://webrecorder.net/",
    "https://webrecorder.net/blog",
    "https://webrecorder.net/tools",
    "https://webrecorder.net/community",
    "https://webrecorder.net/about",
    "https://webrecorder.net/contact",
    "https://webrecorder.net/faq",
  ];

  for (const page of crawled_pages.trim().split("\n")) {
    const url = JSON.parse(page).url;
    if (!url) {
      continue;
    }
    expect(expectedPages.indexOf(url) >= 0).toBe(true);
  }
}, extraHopsTimeout);
