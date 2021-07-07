const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");
const gunzip = require("gunzip-file");

test("check that the warcinfo file works as expected on the command line", async () => {
  jest.setTimeout(30000);

  try{
    var json = {"operator": "test"};
    await exec(`docker-compose run -v $PWD/tests/fixtures:/tests/fixtures crawler crawl --url https://www.example.com --collection warcinfo --warcinfo '${json}' --combineWARC --depth `);
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
