import child_process from "child_process";
import fs from "fs";

test("ensure dryRun crawl only writes pages and logs", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --generateWACZ  --text --collection dry-run-wr-net --combineWARC --rolloverSize 10000 --limit 2 --title "test title" --description "test description" --warcPrefix custom-prefix --dryRun --exclude community',
  );

  const files = fs.readdirSync("test-crawls/collections/dry-run-wr-net").sort();
  expect(files.length).toBe(3);
  expect(files[0]).toBe("logs");
  expect(files[1]).toBe("pages");
  expect(files[1]).toBe("downloads");
});





