const yaml = require("js-yaml");
const child_process = require("child_process");
const fs = require("fs");

function runCrawl(name, config, commandExtra = "") {
  config.generateCDX = true;
  config.depth = 0;
  config.collection = name;
  
  const configYaml = yaml.dump(config);

  try {
    const proc = child_process.execSync(`docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin ${commandExtra}`, {input: configYaml, stdin: "inherit", encoding: "utf8"});

    console.log(proc);
  }
  catch (error) {
    console.log(error);
  }
}

function doesCDXContain(coll, value) {
  const data = fs.readFileSync(`test-crawls/collections/${coll}/indexes/index.cdxj`);
  return data.indexOf(value) >= 0;
}

test("test crawl without ad block for specific URL", () => {
  const config = {
    "url": "https://www.mozilla.org/en-US/firefox/",
  };

  runCrawl("adblock-no-block", config);

  // without ad blocking, URL with googletagmanager is included
  expect(doesCDXContain("adblock-no-block", "www.googletagmanager.com")).toBe(true);
});

test("testcrawl with ad block for specific URL", () => {
  const config = {
    "url": "https://www.mozilla.org/en-US/firefox/",
    "blockAds": true,
  };

  runCrawl("adblock-block", config);

  expect(doesCDXContain("adblock-block", "www.googletagmanager.com")).toBe(false);
});
