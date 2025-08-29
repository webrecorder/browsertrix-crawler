import child_process from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

const PDF = "https://specs.webrecorder.net/wacz/1.1.1/wacz-2021.pdf";
const PDF_HTTP = PDF.replace("https", "http");

const XML = "https://webrecorder.net/feed.xml";
const XML_REDIR = "https://www.webrecorder.net/feed.xml";

test("PDF: ensure pdf is crawled", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls  webrecorder/browsertrix-crawler crawl --url "${PDF}" --collection crawl-pdf`
  );
});

test("PDF: check that individual WARCs have PDF written as 200 response", async () => {
  const archiveWarcLists = fs.readdirSync(
    "test-crawls/collections/crawl-pdf/archive",
  );

  const warcName = path.join("test-crawls/collections/crawl-pdf/archive", archiveWarcLists[0]);

  const nodeStream = fs.createReadStream(warcName);

  const parser = new WARCParser(nodeStream);

  let statusCode = -1;

  for await (const record of parser) {
    if (record.warcType !== "response") {
      continue;
    }

    if (record.warcTargetURI === PDF) {
      statusCode = record.httpHeaders.statusCode;
    }
  }

  expect(statusCode).toBe(200);
});

test("PDF: ensure pdf with redirect is crawled", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls  webrecorder/browsertrix-crawler crawl --url "${PDF_HTTP}" --collection crawl-pdf --generateCDX`
  );
});

test("PDF: check that the pages.jsonl file entry contains status code and mime type", () => {
  expect(
    fs.existsSync("test-crawls/collections/crawl-pdf/pages/pages.jsonl"),
  ).toBe(true);


  const pages = fs
    .readFileSync(
      "test-crawls/collections/crawl-pdf/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  expect(pages.length).toBe(3);

  const page = JSON.parse(pages[1]);
  expect(page.url).toBe(PDF);
  expect(page.status).toBe(200);
  expect(page.mime).toBe("application/pdf");
  expect(page.loadState).toBe(2);

  const pageH = JSON.parse(pages[2]);
  expect(pageH.url).toBe(PDF_HTTP);
  expect(pageH.status).toBe(200);
  expect(pageH.mime).toBe("application/pdf");
  expect(pageH.loadState).toBe(2);
});

test("PDF: check that CDX contains data from two crawls: one pdf 200, one 301 and one 200, two pageinfo entries", () => {
  const filedata = fs.readFileSync(
    "test-crawls/collections/crawl-pdf/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  const lines = filedata.trim().split("\n");
  const cdxj = lines.map(line => JSON.parse(line.split(" ").slice(2).join(" "))).sort((a, b) => a.url < b.url ? -1 : 1);

  expect(cdxj.length).toBe(5);

  expect(cdxj[0].url).toBe(PDF_HTTP);
  expect(cdxj[0].status).toBe("301");

  // this is duplicated as this is data from two crawls
  expect(cdxj[1].url).toBe(PDF);
  expect(cdxj[1].status).toBe("200");
  expect(cdxj[1].mime).toBe("application/pdf");

  expect(cdxj[2].url).toBe(PDF);
  expect(cdxj[2].status).toBe("200");
  expect(cdxj[2].mime).toBe("application/pdf");

  expect(cdxj[3].url).toBe("urn:pageinfo:" + PDF_HTTP);
  expect(cdxj[3].mime).toBe("application/json");

  expect(cdxj[4].url).toBe("urn:pageinfo:" + PDF);
  expect(cdxj[4].mime).toBe("application/json");
});

test("XML: ensure with and without redirect is crawled", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls  webrecorder/browsertrix-crawler crawl --url "${XML}" --url "${XML_REDIR}" --collection crawl-xml --generateCDX`
  );
});

test("XML: check pages.jsonl file entry contains status code and mime type", () => {
  expect(
    fs.existsSync("test-crawls/collections/crawl-xml/pages/pages.jsonl"),
  ).toBe(true);


  const pages = fs
    .readFileSync(
      "test-crawls/collections/crawl-xml/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n");

  expect(pages.length).toBe(3);

  const page = JSON.parse(pages[1]);
  expect(page.url).toBe(XML);
  expect(page.status).toBe(200);
  expect(page.mime).toBe("application/xml");
  expect(page.loadState).toBe(2);

  const pageH = JSON.parse(pages[2]);
  expect(pageH.url).toBe(XML_REDIR);
  expect(pageH.status).toBe(200);
  expect(pageH.mime).toBe("application/xml");
  expect(pageH.loadState).toBe(2);
});

test("XML: check that CDX contains one xml 200, one 301 and one 200, two pageinfo entries", () => {
  const filedata = fs.readFileSync(
    "test-crawls/collections/crawl-xml/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  const lines = filedata.trim().split("\n");
  const cdxj = lines.map(line => JSON.parse(line.split(" ").slice(2).join(" "))).sort((a, b) => a.url < b.url ? -1 : 1);

  expect(cdxj.length).toBe(5);

  expect(cdxj[0].url).toBe("https://webrecorder.net/favicon.ico");

  expect(cdxj[1].url).toBe(XML);
  expect(cdxj[1].status).toBe("200");
  expect(cdxj[1].mime).toBe("application/xml");

  expect(cdxj[2].url).toBe(XML_REDIR);
  expect(cdxj[2].status).toBe("301");

  expect(cdxj[3].url).toBe("urn:pageinfo:" + XML);
  expect(cdxj[3].mime).toBe("application/json");

  expect(cdxj[4].url).toBe("urn:pageinfo:" + XML_REDIR);
  expect(cdxj[4].mime).toBe("application/json");
});


