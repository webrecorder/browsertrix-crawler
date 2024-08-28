import child_process from "child_process";
import fs from "fs";
import path from "path";
import md5 from "md5";

const doValidate = process.argv.filter((x) => x.startsWith('-validate'))[0];
const testIf = (condition, ...args) => condition ? test(...args) : test.skip(...args);

test("ensure basic crawl run with docker run passes", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com/ --generateWACZ  --text --collection wr-net --combineWARC --rolloverSize 10000 --workers 2 --title "test title" --description "test description" --warcPrefix custom-prefix',
  );

  child_process.execSync(
    "unzip test-crawls/collections/wr-net/wr-net.wacz -d test-crawls/collections/wr-net/wacz",
  );
});

testIf(doValidate, "validate wacz", () => {
  child_process.execSync(
    "wacz validate --file ./test-crawls/collections/wr-net/wr-net.wacz",
  );
});

test("check that individual WARCs have correct prefix and are under rollover size", () => {
  const archiveWarcLists = fs.readdirSync(
    "test-crawls/collections/wr-net/archive",
  );

  archiveWarcLists.forEach((filename) => {
    expect(filename.startsWith("custom-prefix-")).toEqual(true);
    const size = fs.statSync(
      path.join("test-crawls/collections/wr-net/archive", filename),
    ).size;
    expect(size < 10000).toEqual(true);
  });
});

test("check that a combined warc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("test-crawls/collections/wr-net");
  var captureFound = 0;

  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith("_0.warc.gz")) {
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});

test("check that a combined warc file is under the rolloverSize", () => {
  const warcLists = fs.readdirSync(
    path.join("test-crawls/collections/wr-net/wacz", "archive"),
  );
  let rolloverSize = 0;

  function getFileSize(filename) {
    return fs.statSync(filename).size;
  }

  for (let i = 0; i < warcLists.length; i++) {
    const size = getFileSize(
      path.join("test-crawls/collections/wr-net/wacz/archive/", warcLists[i]),
    );
    if (size < 10000) {
      rolloverSize = 1;
    }
  }
  expect(rolloverSize).toEqual(1);
});

test("check that the pages.jsonl file exists in the collection under the pages folder", () => {
  expect(
    fs.existsSync("test-crawls/collections/wr-net/pages/pages.jsonl"),
  ).toBe(true);
});

test("check that the pages.jsonl file exists in the wacz under the pages folder", () => {
  expect(
    fs.existsSync("test-crawls/collections/wr-net/wacz/pages/pages.jsonl"),
  ).toBe(true);
});

test("check that the hash in the pages folder and in the unzipped wacz folders match", () => {
  const crawl_hash = md5(
    JSON.parse(
      fs
        .readFileSync(
          "test-crawls/collections/wr-net/wacz/pages/pages.jsonl",
          "utf8",
        )
        .split("\n")[1],
    )["text"],
  );
  const wacz_hash = md5(
    JSON.parse(
      fs
        .readFileSync(
          "test-crawls/collections/wr-net/pages/pages.jsonl",
          "utf8",
        )
        .split("\n")[1],
    )["text"],
  );
  const fixture_hash = md5(
    JSON.parse(
      fs.readFileSync("tests/fixtures/pages.jsonl", "utf8").split("\n")[1],
    )["text"],
  );

  expect(wacz_hash).toEqual(fixture_hash);
  expect(wacz_hash).toEqual(crawl_hash);
});

test("check that the supplied title and description made it into datapackage.json", () => {
  expect(
    fs.existsSync("test-crawls/collections/wr-net/wacz/datapackage.json"),
  ).toBe(true);

  const data = fs.readFileSync(
    "test-crawls/collections/wr-net/wacz/datapackage.json",
    "utf8",
  );
  const dataPackageJSON = JSON.parse(data);
  expect(dataPackageJSON.title).toEqual("test title");
  expect(dataPackageJSON.description).toEqual("test description");
});
