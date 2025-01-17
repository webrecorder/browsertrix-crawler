import child_process from "child_process";
import fs from "fs";
import yaml from "js-yaml";

// Function to run the crawl process
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

// Function to check if the CDX file contains a specific value
function doesCDXContain(coll, value) {
  const data = fs.readFileSync(
    `test-crawls/collections/${coll}/indexes/index.cdxj`,
    "utf8",
  );
  return data.includes(value);
}

// Test case: Crawl with ad block enabled
test("Test crawl with ad block for specific URL", () => {
  const config = {
    url: "https://www.mozilla.org/en-US/firefox/",
    blockAds: true,
  };

  runCrawl("adblock-block", config);

  expect(doesCDXContain("adblock-block", "www.googletagmanager.com")).toBe(
    false, // Expect "www.googletagmanager.com" to NOT be included
  );
});

// Commented-out test case: Crawl without ad block
// Disabled due to inconsistent CI behavior, but left here for future debugging
/*
test("Test crawl without ad block for specific URL", () => {
  const config = {
    url: "https://www.mozilla.org/en-US/firefox/",
    pageExtraDelay: 10,
  };

  runCrawl("adblock-no-block", config);

  expect(doesCDXContain("adblock-no-block", "www.googletagmanager.com")).toBe(
    true, // Expect "www.googletagmanager.com" to be included
  );
});
*/
