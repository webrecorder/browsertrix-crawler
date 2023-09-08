import child_process from "child_process";
import fs from "fs";

test("ensure multi url crawl run with docker run passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url https://webrecorder.net/ --generateWACZ --text --collection advanced --combineWARC --rolloverSize 10000 --workers 2 --title \"test title\" --description \"test description\" --pages 2 --limit 2");

  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler wacz validate --file collections/advanced/advanced.wacz");

});

test("check that the favicon made it into the pages jsonl file", () => {
  expect(fs.existsSync("test-crawls/collections/advanced/pages/pages.jsonl")).toBe(true);

  const data1 = JSON.parse(fs.readFileSync("test-crawls/collections/advanced/pages/pages.jsonl", "utf8").split("\n")[1]);
  const data2 = JSON.parse(fs.readFileSync("test-crawls/collections/advanced/pages/pages.jsonl", "utf8").split("\n")[2]);
  const data = [ data1, data2 ];
  for (const d of data) {
    if (d.url === "https://webrecorder.net/") {
      expect(d.favIconUrl).toEqual("https://webrecorder.net/assets/favicon.ico");
    }
    if (d.url === "https://iana.org/") {
      expect(d.favIconUrl).toEqual("https://www.iana.org/_img/bookmark_icon.ico");
    }
  }
});
