import fs from "fs";

import util from "util";
import { exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

const behaviorLinksTimeout = 180000;

test(
  "check that scope is correctly respected when not seeing alwaysAddBehaviorLinks",
  async () => {
    fs.rmSync("./test-crawls/collections/alwaysAddBehaviorLinks-missing", {
      recursive: true,
      force: true,
    });

    try {
      await exec(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures/:/custom-behaviors/ -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --customBehaviors /custom-behaviors/addlink.js --collection alwaysAddBehaviorLinks-missing --url https://old.webrecorder.net/ --scopeType page",
      );
    } catch (error) {
      console.log(error);
    }

    const crawledPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks-missing/pages/pages.jsonl",
      "utf8",
    );
    const crawledPagesArray = crawledPages.trim().split("\n");
    const crawledPagesUrls = crawledPagesArray
      .slice(1, crawledPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const crawledExtraPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks-missing/pages/extraPages.jsonl",
      "utf8",
    );
    const crawledExtraPagesArray = crawledExtraPages.trim().split("\n");
    const crawledExtraPagesUrls = crawledExtraPagesArray
      .slice(1, crawledExtraPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const expectedPages = ["https://old.webrecorder.net/"];
    expect(crawledPagesUrls).toEqual(expectedPages);

    expect(crawledExtraPagesUrls).not.toContain(
      "https://example-com.webrecorder.net",
    );
  },
  behaviorLinksTimeout,
);

test(
  "check that addLink adds to scope when setting alwaysAddBehaviorLinks",
  async () => {
    fs.rmSync("./test-crawls/collections/alwaysAddBehaviorLinks", {
      recursive: true,
      force: true,
    });

    try {
      await exec(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures/:/custom-behaviors/ -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --customBehaviors /custom-behaviors/addlink.js --collection alwaysAddBehaviorLinks --alwaysAddBehaviorLinks --url https://old.webrecorder.net/ --scopeType page",
      );
    } catch (error) {
      console.log(error);
    }

    const crawledPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks/pages/pages.jsonl",
      "utf8",
    );
    const crawledPagesArray = crawledPages.trim().split("\n");
    const crawledPagesUrls = crawledPagesArray
      .slice(1, crawledPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const crawledExtraPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks/pages/extraPages.jsonl",
      "utf8",
    );
    const crawledExtraPagesArray = crawledExtraPages.trim().split("\n");
    const crawledExtraPagesUrls = crawledExtraPagesArray
      .slice(1, crawledExtraPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const expectedPages = ["https://old.webrecorder.net/"];
    expect(crawledPagesUrls).toEqual(expectedPages);

    expect(crawledExtraPagesUrls).toContain(
      "https://example-com.webrecorder.net/",
    );
  },
  behaviorLinksTimeout,
);

test(
  "check that --limit 1 is still respected when addLink adds to scope using alwaysAddBehaviorLinks",
  async () => {
    fs.rmSync("./test-crawls/collections/alwaysAddBehaviorLinks-limit1", {
      recursive: true,
      force: true,
    });

    try {
      await exec(
        "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures/:/custom-behaviors/ -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --customBehaviors /custom-behaviors/addlink.js --collection alwaysAddBehaviorLinks-limit1 --alwaysAddBehaviorLinks --url https://old.webrecorder.net/ --scopeType page --limit 1",
      );
    } catch (error) {
      console.log(error);
    }

    const crawledPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks-limit1/pages/pages.jsonl",
      "utf8",
    );
    const crawledPagesArray = crawledPages.trim().split("\n");
    const crawledPagesUrls = crawledPagesArray
      .slice(1, crawledPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const crawledExtraPages = fs.readFileSync(
      "test-crawls/collections/alwaysAddBehaviorLinks-limit1/pages/extraPages.jsonl",
      "utf8",
    );
    const crawledExtraPagesArray = crawledExtraPages.trim().split("\n");
    const crawledExtraPagesUrls = crawledExtraPagesArray
      .slice(1, crawledExtraPagesArray.length)
      .map((line) => {
        const parsed = JSON.parse(line);
        return parsed.url;
      });

    const expectedPages = ["https://old.webrecorder.net/"];
    expect(crawledPagesUrls).toEqual(expectedPages);

    expect(crawledExtraPagesUrls).toHaveLength(0);
  },
  behaviorLinksTimeout,
);
