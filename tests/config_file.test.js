const yaml = require("js-yaml");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");

test("check yaml config file with seed list is used", async () => {
  jest.setTimeout(30000);

  try{

    await exec("docker-compose run -v $PWD/crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures crawler crawl --collection configtest --yamlConfig /tests/fixtures/crawl-1.yaml --limit 3 --timeout 20000");
  }
  catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync("crawls/collections/configtest/pages/pages.jsonl", "utf8");
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    pages.add(JSON.parse(line).url);
  }

  const config = yaml.safeLoad(fs.readFileSync("tests/fixtures/crawl-1.yaml", "utf8"));

  let foundAllSeeds = true; 

  for (const seed of config.seeds) {
    const url = new URL(seed).href;
    if (!pages.has(url)) {
      foundAllSeeds = false;
    }
  }
  expect(foundAllSeeds).toBe(true);

  expect(fs.existsSync("crawls/collections/configtest/configtest.wacz")).toBe(true);

});
