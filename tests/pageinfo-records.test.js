import child_process from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

test("run warc and ensure pageinfo records contain the correct resources", async () => {
  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --url https://webrecorder.net/about --scopeType page --collection page-info-test --combineWARC",
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
  }

  expect(foundIndex).toBe(true);
  expect(foundAbout).toBe(true);
});

function validateResourcesIndex(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("ts");
  expect(json).toHaveProperty("urls");
  expect(json.urls).toEqual({
    "https://webrecorder.net/": {
      status: 200,
      mime: "text/html",
      type: "Document",
    },
    "https://webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "Stylesheet",
    },
    "https://webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "Image",
    },
    "https://webrecorder.net/assets/tools/awp-icon.png": {
      status: 200,
      mime: "image/png",
      type: "Image",
    },
    "https://webrecorder.net/assets/tools/logo-pywb.png": {
      status: 200,
      mime: "image/png",
      type: "Image",
    },
    "https://webrecorder.net/assets/tools/browsertrixcrawler.png": {
      status: 200,
      mime: "image/png",
      type: "Image",
    },
    "https://webrecorder.net/assets/tools/rwp-icon.png": {
      status: 200,
      mime: "image/png",
      type: "Image",
    },
    "https://webrecorder.net/assets/images/btrix-cloud.png": {
      status: 200,
      mime: "image/png",
      type: "Image",
    },
    "https://webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "Stylesheet",
    },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "Stylesheet" },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "Stylesheet" },
    "https://stats.browsertrix.com/js/script.js": {
      status: 200,
      mime: "application/javascript",
      type: "Script",
    },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "Font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "Font" },
    "https://webrecorder.net/assets/favicon.ico": {
      status: 200,
      mime: "image/vnd.microsoft.icon",
      type: "Other",
    },
    "https://stats.browsertrix.com/api/event?__wb_method=POST&n=pageview&u=https%3A%2F%2Fwebrecorder.net%2F&d=webrecorder.net":
      { status: 202, mime: "text/plain", type: "XHR" },
  });
}

function validateResourcesAbout(json) {
  expect(json).toHaveProperty("pageid");
  expect(json).toHaveProperty("url");
  expect(json).toHaveProperty("ts");
  expect(json).toHaveProperty("urls");
  expect(json.urls).toEqual({
    "https://webrecorder.net/about": {
      status: 200,
      mime: "text/html",
      type: "Document",
    },
    "https://webrecorder.net/assets/main.css": {
      status: 200,
      mime: "text/css",
      type: "Stylesheet",
    },
    "https://webrecorder.net/assets/fontawesome/all.css": {
      status: 200,
      mime: "text/css",
      type: "Stylesheet",
    },
    "https://fonts.googleapis.com/css?family=Source+Code+Pro|Source+Sans+Pro&display=swap":
      { status: 200, mime: "text/css", type: "Stylesheet" },
    "https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@700;900&display=swap":
      { status: 200, mime: "text/css", type: "Stylesheet" },
    "https://stats.browsertrix.com/js/script.js": {
      status: 200,
      mime: "application/javascript",
      type: "Script",
    },
    "https://webrecorder.net/assets/wr-logo.svg": {
      status: 200,
      mime: "image/svg+xml",
      type: "Image",
    },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xK3dSBYKcSV-LCoeQqfX1RYOo3qOK7l.woff2":
      { status: 200, mime: "font/woff2", type: "Font" },
    "https://fonts.gstatic.com/s/sourcesanspro/v22/6xKydSBYKcSV-LCoeQqfX1RYOo3ig4vwlxdu.woff2":
      { status: 200, mime: "font/woff2", type: "Font" },
  });
}
