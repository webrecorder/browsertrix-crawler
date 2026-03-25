import fs from "fs";

import util from "util";
import { exec as execCallback, execSync } from "child_process";

const exec = util.promisify(execCallback);

const extraHopsTimeout = 180000;

test(
  "check that URLs are crawled 2 extra hops beyond depth",
  async () => {
    try {
      await exec(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection extra-hops-beyond --extraHops 2 --url https://old.webrecorder.net/ --limit 5 --timeout 10 --exclude community --exclude tools",
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
      "https://old.webrecorder.net/",
    ];

    const expectedExtraPages = [
      "https://old.webrecorder.net/blog",
      "https://old.webrecorder.net/about",
      "https://old.webrecorder.net/contact",
      "https://old.webrecorder.net/faq",
    ];

    // first line is the header, not page, so adding -1
    expect(crawledPagesArray.length - 1).toEqual(expectedPages.length);
    expect(crawledExtraPagesArray.length - 1).toEqual(expectedExtraPages.length);

    for (const page of crawledPagesArray) {
      const parsedPage = JSON.parse(page);
      const url = parsedPage.url;
      if (!url) {
        continue;
      }
      expect(expectedPages.indexOf(url) >= 0).toBe(true);

      expect(parsedPage.seed).toEqual(true);
      expect(parsedPage.depth).toEqual(0);
    }

    for (const page of crawledExtraPagesArray) {
      const parsedPage = JSON.parse(page);
      const url = parsedPage.url;
      if (!url) {
        continue;
      }
      expect(expectedExtraPages.indexOf(url) >= 0).toBe(true);
      expect(parsedPage.depth >= 1).toBe(true);
    }
  },
  extraHopsTimeout,
);


test("extra hops applies beyond depth limit", () => {
    try {
      execSync(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection extra-hops-depth-0 --extraHops 1 --url https://old.webrecorder.net/ --limit 2 --depth 0 --timeout 10 --exclude community --exclude tools",
      );
    } catch (error) {
      console.log(error);
    }

    const crawledExtraPages = fs.readFileSync(
      "test-crawls/collections/extra-hops-depth-0/pages/extraPages.jsonl",
      "utf8",
    );
    const crawledExtraPagesArray = crawledExtraPages.trim().split("\n");

    expect(crawledExtraPagesArray.length - 1).toEqual(1);
});

