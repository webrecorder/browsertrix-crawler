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

test("test rule based on iframe text not matching, plus allowOnly iframe", () => {
  const config = {
    "url": "https://oembed.link/https://www.youtube.com/watch?v=aT-Up5Y4uRI",
    "blockRules": [{
      "url": "example.com/embed/",
      "frameTextMatch": "\\\\\"channelId\\\\\":\\\\\"UCrQElMF25VP-1JjhBuFsW_Q\\\\\"",
      "type": "block"
    }, {
      "url": "(youtube.com|example.com)/embed/",
      "type": "allowOnly",
      "inFrameUrl": "oembed.link/",
    }]
  };

  runCrawl("non-block-5", config);

  expect(doesCDXContain("non-block-5", "\"video/mp4\"")).toBe(true);
});

test("test block url in frame url", () => {
  const config = {
    "url": "https://oembed.link/https://www.youtube.com/watch?v=aT-Up5Y4uRI",
    "blockRules": [{
      "url": "maxresdefault.jpg",
      "type": "block",
      "inFrameUrl": "youtube.com/embed",
    }]
  };

  runCrawl("block-6", config);

  expect(doesCDXContain("block-6", "\"https://i.ytimg.com/vi/aT-Up5Y4uRI/maxresdefault.jpg\"")).toBe(false);
});


test("test block rules complex example, block other iframes, but not youtube", () => {
  const config = {
    "seeds": [
      "https://hdsr.mitpress.mit.edu/pub/xcq8a1v1",
      "https://hdsr.mitpress.mit.edu/pub/3csmghzj/release/1"
    ],
    "depth": "0",
    "blockRules": [{
      "url": "(pubpub.org|polyfill.io|typekit.net|hdsr.mitpress.mit.edu|www.youtube.com)",
      "type": "allowOnly",
      "inFrameUrl": "hdsr.mitpress.mit.edu"
    }, {
      "url": "https://www.youtube.com/embed/",
      "type": "allowOnly",
      "frameTextMatch": "(\\\\\"channelId\\\\\":\\\\\"UCl0IFA3-VcWOadMbNiUH2aw\\\\\")"
    }],
    "include": "(hdsr.mitpress.mit.edu|assets.pubpub.org)",

    "combineWARC": true,

    "logging": 'stats,debug'
  };


  runCrawl("block-7", config);

  expect(doesCDXContain("block-7", "\"https://mit-harvard.netlify.com/\"")).toBe(false);  
  expect(doesCDXContain("block-7", "\"video/mp4\"")).toBe(true);
});



