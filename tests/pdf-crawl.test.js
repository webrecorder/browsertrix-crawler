import child_process from "child_process";
import fs from "fs";
import path from "path";
import { WARCParser } from "warcio";

const PDF = "http://bibnum.bnf.fr/WARC/WARC_ISO_28500_version1_latestdraft.pdf";

test("ensure pdf is crawled", async () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls  webrecorder/browsertrix-crawler crawl --url "${PDF}" --collection crawl-pdf`
  );
});

test("check that individual WARCs have PDF written as 200 response", async () => {
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


test("check that the pages.jsonl file entry contains status code and mime type", () => {
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

  expect(pages.length).toBe(2);

  const page = JSON.parse(pages[1]);
  expect(page.url).toBe(PDF);
  expect(page.status).toBe(200);
  expect(page.mime).toBe("application/pdf");
});
