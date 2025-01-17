import child_process from "child_process";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

// Define an interface for the config object
interface CrawlConfig {
  url: string;
  blockAds?: boolean;
  pageExtraDelay?: number;
  generateCDX?: boolean;
  depth?: number;
  collection?: string;
}

// Function to run the crawl process
function runCrawl(name: string, config: CrawlConfig, commandExtra = "") {
  // Ensure required config properties
  config.generateCDX = true;
  config.depth = 0;
  config.collection = name;

  // Convert config to YAML
  const configYaml = yaml.dump(config);

  try {
    // Execute the Docker command with the YAML config
    const output = child_process.execSync(
      `docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin ${commandExtra}`,
      { input: configYaml, stdin: "inherit", encoding: "utf8" },
    );

    console.log("Crawl completed successfully:", output);
  } catch (error) {
    console.error("Error during crawl process:", error);
    throw error; // Rethrow the error if needed for higher-level handling
  }
}

// Function to check if the CDX file contains a specific value
function doesCDXContain(coll: string, value: string): boolean {
  const filePath = path.join("test-crawls", "collections", coll, "indexes", "index.cdxj");

  try {
    const data = fs.readFileSync(filePath, "utf8");
    return data.includes(value);
  } catch (error) {
    console.error(`Error reading CDX file at ${filePath}:`, error);
    return false; // Return false if the file can't be read
  }
}

// Helper function for tests to reduce duplication
function testCrawl(config: CrawlConfig, collectionName: string, expectedValue: string, shouldContain: boolean) {
  runCrawl(collectionName, config);
  const contains = doesCDXContain(collectionName, expectedValue);
  expect(contains).toBe(shouldContain);
}

// Test cases
test("Test crawl with ad block for specific URL", () => {
  const config: CrawlConfig = {
    url: "https://www.mozilla.org/en-US/firefox/",
    blockAds: true,
  };

  testCrawl(
    config,
    "adblock-block",
    "www.googletagmanager.com",
    false, // Expect "www.googletagmanager.com" to NOT be included
  );
});

// Test Disabled for Brave -- should always be blocked, but seeing inconsistent CI behavior
/*
test("Test crawl without ad block for specific URL", () => {
  const config: CrawlConfig = {
    url: "https://www.mozilla.org/en-US/firefox/",
    pageExtraDelay: 10,
  };

  testCrawl(
    config,
    "adblock-no-block",
    "www.googletagmanager.com",
    true, // Expect "www.googletagmanager.com" to be included
  );
});
*/
