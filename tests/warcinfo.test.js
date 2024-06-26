import fs from "fs";
import zlib from "zlib";
import path from "path";
import child_process from "child_process";

test("run crawl", async() => {
  let success = false;

  try {
    const configYaml = fs.readFileSync("tests/fixtures/crawl-2.yaml", "utf8");
    const proc = child_process.execSync(
      "docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin --limit 1 --collection warcinfo --combineWARC",
      { input: configYaml, stdin: "inherit", encoding: "utf8" },
    );

    //console.log(proc);
    success = true;
  } catch (error) {
    console.log(error);
  }

  expect(success).toBe(true);
});

test("check that the warcinfo for individual WARC is as expected", async () => {

  const warcs = fs.readdirSync("test-crawls/collections/warcinfo/archive/");

  let filename = "";

  for (const name of warcs) {
    if (name.startsWith("rec-")) {
      filename = path.join("test-crawls/collections/warcinfo/archive/", name);
      break;
    }
  }

  const warcData = fs.readFileSync(filename);

  const data = zlib.gunzipSync(warcData);

  const string = data.toString("utf8");

  expect(string.indexOf("operator: test")).toBeGreaterThan(-1);
  expect(string.indexOf("host: hostname")).toBeGreaterThan(-1);
  expect(
    string.match(/Browsertrix-Crawler \d[\w.-]+ \(with warcio.js \d[\w.-]+\)/),
  ).not.toEqual(null);
  expect(string.indexOf("format: WARC File Format 1.1")).toBeGreaterThan(-1);
});

test("check that the warcinfo for combined WARC file is as expected", async () => {
  const warcData = fs.readFileSync(
    "test-crawls/collections/warcinfo/warcinfo_0.warc.gz",
  );

  const data = zlib.gunzipSync(warcData);

  const string = data.toString("utf8");

  expect(string.indexOf("operator: test")).toBeGreaterThan(-1);
  expect(string.indexOf("host: hostname")).toBeGreaterThan(-1);
  expect(
    string.match(/Browsertrix-Crawler \d[\w.-]+ \(with warcio.js \d[\w.-]+\)/),
  ).not.toEqual(null);
  expect(string.indexOf("format: WARC File Format 1.1")).toBeGreaterThan(-1);
});
