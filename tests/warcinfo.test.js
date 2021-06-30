const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");
const gunzip = require('gunzip-file')

test("check that the warcinfo file works as expected on the command line", async () => {
  jest.setTimeout(30000);

  try{
    var json = JSON.stringify({"operator": "test"})

    await exec(`docker-compose run -v $PWD/tests/fixtures:/tests/fixtures crawler crawl --collection warcinfo --warcinfo '${json}' --combineWARC --depth `);
  }
  catch (error) {
    console.log(error);
  }

  var input = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc.gz", "binary");

  await gunzip("crawls/collections/warcinfo/warcinfo_0.warc.gz", "crawls/collections/warcinfo/warcinfo_0.warc", () => {});
  var input = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc", "utf8");
  var foundWarc = input.indexOf('operator')
  expect(foundWarc).toBeGreaterThan(-1);
});

test("check that the warcinfo works in the yaml config", async () => {
  jest.setTimeout(30000);

  try{
    await exec("docker-compose run -v $PWD/tests/fixtures:/tests/fixtures crawler crawl --collection warcinfo--config /tests/fixtures/crawl-2.yaml  --combineWARC --depth 0");
  }
  catch (error) {
    console.log(error);
  }

  var input = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc.gz", "binary");

  await gunzip("crawls/collections/warcinfo/warcinfo_0.warc.gz", "crawls/collections/warcinfo/warcinfo_0.warc", () => {});
  var input = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc", "utf8");
  var foundWarc = input.indexOf('operator')
  expect(foundWarc).toBeGreaterThan(-1);
});
