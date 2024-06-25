import fs from "fs";
import { execSync } from "child_process";

test("check that gclid query URL is automatically redirected to remove it", async () => {
  try {
    execSync(
      "docker run --rm  -v $PWD/test-crawls:/crawls -i webrecorder/browsertrix-crawler crawl --url 'https://webrecorder.net/about?gclid=abc' --collection test-brave-redir --behaviors \"\" --limit 1 --generateCDX");

  } catch (error) {
    console.log(error.stderr);
  }

  const filedata = fs.readFileSync(
    "test-crawls/collections/test-brave-redir/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  let responseFound = false;
  let redirectFound = false;

  const lines = filedata.trim().split("\n");

  for (const line of lines) {
    const json = line.split(" ").slice(2).join(" ");
    const data = JSON.parse(json);
    if (data.url === "https://webrecorder.net/about?gclid=abc" && data.status === "307") {
      redirectFound = true;
    } else if (data.url === "https://webrecorder.net/about" && data.status === "200") {
      responseFound = true;
    }
    if (responseFound && redirectFound) {
      break;
    }
  }

  expect(redirectFound && responseFound).toBe(true);
});
