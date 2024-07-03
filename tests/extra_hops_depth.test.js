import fs from "fs";

import util from "util";
import { exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

const extraHopsTimeout = 180000;

test(
  "check that URLs are crawled 2 extra hops beyond depth",
  async () => {
    try {
      await exec(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection extra-hops-beyond --extraHops 2 --url https://webrecorder.net/ --limit 5 --timeout 10 --exclude community --exclude tools",
      );
    } catch (error) {
      console.log(error);
    }

    const crawledPages = fs.readFileSync(
      "test-crawls/collections/extra-hops-beyond/pages/pages.jsonl",
      "utf8",
    );
    const crawledPagesArray = crawledPages.trim().split("\n");

    const crawledExtraPages = fs.readFileSync(
      "test-crawls/collections/extra-hops-beyond/pages/extraPages.jsonl",
      "utf8",
    );
    const crawledExtraPagesArray = crawledExtraPages.trim().split("\n");

    const expectedPages = [
      "https://webrecorder.net/",
    ];

    const expectedExtraPages = [
      "https://webrecorder.net/blog",
      "https://webrecorder.net/about",
      "https://webrecorder.net/contact",
      "https://webrecorder.net/faq",
    ];

    // first line is the header, not page, so adding -1
    expect(crawledPagesArray.length - 1).toEqual(expectedPages.length);
    expect(crawledExtraPagesArray.length - 1).toEqual(expectedExtraPages.length);

    for (const page of crawledPagesArray) {
      const url = JSON.parse(page).url;
      if (!url) {
        continue;
      }
      expect(expectedPages.indexOf(url) >= 0).toBe(true);
    }

    for (const page of crawledExtraPagesArray) {
      const url = JSON.parse(page).url;
      if (!url) {
        continue;
      }
      expect(expectedExtraPages.indexOf(url) >= 0).toBe(true);
    }
  },
  extraHopsTimeout,
);
