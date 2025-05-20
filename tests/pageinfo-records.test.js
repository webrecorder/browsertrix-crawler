import child_process from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

test("run warc and ensure pageinfo records contain the correct resources", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --url https://old.webrecorder.net/about --url https://invalid.invalid/ --scopeType page --collection page-info-test --combineWARC",
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
    if (record.warcType === "response" &&
      (record.warcTargetURI === "https://old.webrecorder.net/" || record.warcTargetURI === "https://old.webrecorder.net/about")) {
      expect(record.warcHeaders.headers.get("WARC-Protocol")).toBe("h2, tls/1.3");
    }

    if (
      !foundIndex &&
      record.warcTargetURI === "urn:pageinfo:https://old.webrecorder.net/"
    ) {
      foundIndex = true;
      const text = await record.contentText();
      validateResourcesIndex(JSON.parse(text));
    }

    if (
      !foundAbout &&
      record.warcTargetURI === "urn:pageinfo:https://old.webrecorder.net/about"
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
    "https://old.webrecorder.net/": {
      status: 200,
      mime: "text/html",
      type: "document",
    },
    "https://old.webrecorder.net/assets/tools/logo-pywb.png": {
      mime: "image/png",
      status: 200,
      type: "image",
    },
    "https://old.webrecorder.net/assets/brand/archivewebpage-icon-color.svg": {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://old.webrecorder.net/assets/brand/browsertrix-icon-color.svg": {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://old.webrecorder.net/assets/brand/browsertrixcrawler-icon-color.svg": {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://old.webrecorder.net/assets/brand/replaywebpage-icon-color.svg": {
      mime: "image/svg+xml",
      status: 200,
      type: "image",
    },
    "https://old.webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://old.webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "image",
    },
    "https://old.webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://old.webrecorder.net/assets/favicon.ico": {
      status: 200,
      mime: "image/vnd.microsoft.icon",
      type: "other",
    },
  });
}

function validateResourcesAbout(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("ts");
  expect(json).toHaveProperty("urls");
  expect(json.counts).toEqual({ jsErrors: 0 });
  expect(json.urls).toEqual({
    "https://old.webrecorder.net/about": {
      status: 200,
      mime: "text/html",
      type: "document",
    },
    "https://old.webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://old.webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "stylesheet",
    },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "stylesheet" },
    "https://old.webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "image",
    },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "font" },
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
