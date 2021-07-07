const fs = require("fs");
const gunzip = require("gunzip-file");
const child_process = require("child_process");

test("check that the warcinfo file works as expected on the command line", async () => {
  jest.setTimeout(30000);

  try{
    const configYaml = fs.readFileSync("tests/fixtures/crawl-2.yaml", "utf8");
    const version = require("../package.json").version;
    const proc = child_process.execSync(`docker run -i -v $PWD/crawls:/crawls webrecorder/browsertrix-crawler:${version} crawl --config stdin --exclude webrecorder.net/202`, {input: configYaml, stdin: "inherit", encoding: "utf8"});

    console.log(proc);
  }
  catch (error) {
    console.log(error);
  }

  await gunzip("crawls/collections/warcinfo/warcinfo_0.warc.gz", "crawls/collections/warcinfo/warcinfo_0.warc", () => {
    var data = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc", "utf-8");
    var foundWarc = data.indexOf("operator");
    expect(foundWarc).toBeGreaterThan(-1);

  });

});
