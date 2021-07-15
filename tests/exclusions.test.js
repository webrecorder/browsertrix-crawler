const yaml = require("js-yaml");
const child_process = require("child_process");
const fs = require("fs");

function runCrawl(name, config, commandExtra = "") {
  config.generateCDX = true;
  config.depth = 0;
  config.collection = name;
  
  const configYaml = yaml.dump(config);

  try {
    const version = require("../package.json").version;
    const proc = child_process.execSync(`docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler:${version} crawl --config stdin ${commandExtra}`, {input: configYaml, stdin: "inherit", encoding: "utf8"});

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

test("test crawl without block for specific URL", () => {
  const config = {
    "url": "https://www.iana.org/",
  };

  runCrawl("block-1-no-block", config);

  // without blocks, URL with add sense is included
  expect(doesCDXContain("block-1-no-block", "https://cse.google.com/adsense/search/async-ads.js")).toBe(true);
});


test("test block rule on specific URL", () => {
  const config = {
    "url": "https://www.iana.org/",
    "blockRules": [
      {"url": "adsense"}
    ]
  };

  runCrawl("block-1", config);

  expect(doesCDXContain("block-1", "https://cse.google.com/adsense/search/async-ads.js")).toBe(false);
});

test("test block rule based on iframe text, content included due to match", () => {
  const config = {
    "url": "https://oembed.link/https://www.youtube.com/watch?v=aT-Up5Y4uRI",
    "blockRules": [{
      "url": "https://www.youtube.com/embed/",
      "frameTextMatch": "\\\\\"channelId\\\\\":\\\\\"UCrQElMF25VP-1JjhBuFsW_Q\\\\\"",
      "type": "allowOnly"
    }]
  };

  runCrawl("block-2", config);

  expect(doesCDXContain("block-2", "\"video/mp4\"")).toBe(true);
});


test("test block rule based on iframe text, wrong text, content should be excluded", () => {
  const config = {
    "url": "https://oembed.link/https://www.youtube.com/watch?v=aT-Up5Y4uRI",
    "blockRules": [{
      "url": "https://www.youtube.com/embed/",
      "frameTextMatch": "\\\\\"channelId\\\\\":\\\\\"UCrQElMF25VP-1JjhBuFsW_R\\\\\"",
      "type": "allowOnly"
    }]
  };

  runCrawl("block-3", config);

  expect(doesCDXContain("block-3", "\"video/mp4\"")).toBe(false);
});


test("test block rule based on iframe text, block matched", () => {
  const config = {
    "url": "https://oembed.link/https://www.youtube.com/watch?v=aT-Up5Y4uRI",
    "blockRules": [{
      "url": "https://www.youtube.com/embed/",
      "frameTextMatch": "\\\\\"channelId\\\\\":\\\\\"UCrQElMF25VP-1JjhBuFsW_Q\\\\\"",
    }]
  };

  runCrawl("block-4", config);

  expect(doesCDXContain("block-4", "\"video/mp4\"")).toBe(false);
});


