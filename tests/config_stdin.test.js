import child_process from "child_process";
import fs from "fs";
import yaml from "js-yaml";

test("pass config file via stdin", async () => {
  const configYaml = fs.readFileSync("tests/fixtures/crawl-2.yaml", "utf8");
  const config = yaml.load(configYaml);

  try {
    const proc = child_process.execSync(
      "docker run -i -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin --scopeExcludeRx webrecorder.net/202",
      { input: configYaml, stdin: "inherit", encoding: "utf8" },
    );

    //console.log(proc);
  } catch (error) {
    console.log(error);
  }

  const crawledPages = fs.readFileSync(
    "test-crawls/collections/config-stdin/pages/pages.jsonl",
    "utf8",
  );
  const pages = new Set();

  for (const line of crawledPages.trim().split("\n")) {
    const url = JSON.parse(line).url;
    if (!url) {
      continue;
    }
    pages.add(url);
    expect(url.indexOf("webrecorder.net/202")).toEqual(-1);
  }

  let foundAllSeeds = true;

  for (const seed of config.seeds) {
    const url = new URL(seed).href;
    if (!pages.has(url)) {
      foundAllSeeds = false;
    }
  }
  expect(foundAllSeeds).toBe(true);

  expect(
    fs.existsSync("test-crawls/collections/config-stdin/config-stdin.wacz"),
  ).toBe(true);
});
