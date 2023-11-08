import fs from "fs";
import zlib from "zlib";
import child_process from "child_process";

test("check that the warcinfo file works as expected on the command line", async () => {
  try {
    const configYaml = fs.readFileSync("tests/fixtures/crawl-2.yaml", "utf8");
    const proc = child_process.execSync(
      "docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin --limit 1 --collection warcinfo --combineWARC",
      { input: configYaml, stdin: "inherit", encoding: "utf8" },
    );

    console.log(proc);
  } catch (error) {
    console.log(error);
  }

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
  expect(string.indexOf("format: WARC File Format 1.0")).toBeGreaterThan(-1);
});
