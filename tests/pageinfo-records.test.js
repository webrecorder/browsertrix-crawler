import child_process from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

test("run warc and ensure pageinfo records contain the correct resources", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --url https://webrecorder.net/about --url https://invalid.invalid/ --scopeType page --collection page-info-test --combineWARC",
  );

  const filename = path.join(
    "test-crawls",
    "collections",
    "page-info-test",
    "page-info-test_0.warc.gz",
  );

  const nodeStream = fs.createReadStream(filename);

  const parser = new WARCParser(nodeStream);

  let foundIndex = false;
  let foundAbout = false;
  let foundInvalid = false;

  for await (const record of parser) {
    if (
      !foundIndex &&
      record.warcTargetURI === "urn:pageinfo:https://webrecorder.net/"
    ) {
      foundIndex = true;
      const text = await record.contentText();
      validateResourcesIndex(JSON.parse(text));
    }

    if (
      !foundAbout &&
      record.warcTargetURI === "urn:pageinfo:https://webrecorder.net/about"
    ) {
      foundAbout = true;
      const text = await record.contentText();
      validateResourcesAbout(JSON.parse(text));
    }

    if (
      !foundInvalid &&
      record.warcTargetURI === "urn:pageinfo:https://invalid.invalid/"
    ) {
      foundInvalid = true;
      const text = await record.contentText();
      validateResourcesInvalid(JSON.parse(text));
    }
  }

  expect(foundIndex).toBe(true);
  expect(foundAbout).toBe(true);
  expect(foundInvalid).toBe(true);
});

function validateResourcesIndex(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("ts");
  expect(json).toHaveProperty("urls");
  expect(json.counts).toEqual({ jsErrors: 0 });
  expect(json.urls).toEqual({
    "https://webrecorder.net/": {
      status: 200,
      mime: "text/html",
      type: "document",
    },
    "https://webrecorder.net/assets/brand/archivewebpage-icon-color.svg": Object {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://webrecorder.net/assets/brand/browsertrix-icon-color.svg": Object {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://webrecorder.net/assets/brand/browsertrixcrawler-icon-color.svg": Object {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://webrecorder.net/assets/brand/replaywebpage-icon-color.svg": Object {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "image",
    },
    "https://webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://stats.browsertrix.com/js/script.js": {
      status: 200,
      mime: "application/javascript",
      type: "script",
    },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://webrecorder.net/assets/favicon.ico": {
      status: 200,
      mime: "image/vnd.microsoft.icon",
      type: "other",
    },
    "https://stats.browsertrix.com/api/event?__wb_method=POST&n=pageview&u=https%3A%2F%2Fwebrecorder.net%2F&d=webrecorder.net":
      { status: 202, mime: "text/plain", type: "xhr" },
  });
}

function validateResourcesAbout(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("ts");
  expect(json).toHaveProperty("urls");
  expect(json.counts).toEqual({ jsErrors: 0 });
  expect(json.urls).toEqual({
    "https://webrecorder.net/about": {
      status: 200,
      mime: "text/html",
      type: "document",
    },
    "https://webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://stats.browsertrix.com/js/script.js": {
      status: 200,
      mime: "application/javascript",
      type: "script",
    },
    "https://webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "image",
    },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://stats.browsertrix.com/api/event?__wb_method=POST&n=pageview&u=https%3A%2F%2Fwebrecorder.net%2Fabout&d=webrecorder.net":
      {
        status: 0,
        type: "xhr",
        error: "net::ERR_BLOCKED_BY_CLIENT",
      },
  });
}

function validateResourcesInvalid(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("urls");
  expect(json.counts).toEqual({ jsErrors: 0 });
  expect(json.urls).toEqual({
    "https://invalid.invalid/": {
      status: 0,
      type: "document",
      error: "net::ERR_NAME_NOT_RESOLVED",
    },
  });
}
