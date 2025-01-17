import child_process from "child_process";
import fs from "fs";
import yaml from "js-yaml";

function runCrawl(name, config, commandExtra = "") {
  config.generateCDX = true;
  config.depth = 0;
  config.collection = name;

  const configYaml = yaml.dump(config);

  try {
    const output = child_process.execSync(
      `docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin ${commandExtra}`,
      { input: configYaml, stdin: "inherit", encoding: "utf8" },
    );

    console.log("Crawl completed successfully:", output);
  } catch (error) {
    console.error("Error during crawl process:", error);
    throw error;
  }
}

function doesCDXContain(coll, value) {
  const data = fs.readFileSync(
    `test-crawls/collections/${coll}/indexes/index.cdxj`,
  );
  return data.includes(value);
}

test("test crawl with ad block for specific URL", () => {
  const config = {
    url: "https://www.mozilla.org/en-US/firefox/",
    blockAds: true,
  };

  runCrawl("adblock-block", config);

  expect(doesCDXContain("adblock-block", "www.googletagmanager.com")).toBe(
    false,
  );
});
