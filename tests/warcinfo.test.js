const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");
const gunzip = require("gunzip");

test("check that the warcinfo file works as expected on the command line", async () => {
  jest.setTimeout(30000);

  try{

    await exec("docker-compose run -v $PWD/tests/fixtures:/tests/fixtures crawler crawl --collection warcinfo --warcinfo '{'operator': 'test'}' --combineWARC --depth 0");
  }
  catch (error) {
    console.log(error);
  }
  gunzip("crawls/collections/warcinfo/warcinfo_0.warc.gz', 'crawls/collections/warcinfo/warcinfo_0.warc", () => {
  });
  const warc = fs.readFileSync("crawls/collections/warcinfo/warcinfo_0.warc", "utf8");

  var foundOperator = "operator" in warc;

  expect(foundOperator).toBe(true);
});
