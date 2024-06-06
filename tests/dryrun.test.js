import child_process from "child_process";
import fs from "fs";

test("ensure dryRun crawl only writes logs", async () => {
  child_process.execSync(
    'docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --generateWACZ  --text --collection dry-run-wr-net --combineWARC --rolloverSize 10000 --limit 2 --title "test title" --description "test description" --warcPrefix custom-prefix --dryRun',
  );

  const files = fs.readdirSync("test-crawls/collections/dry-run-wr-net");
  expect(files.length).toBe(1);
  expect(files[0]).toBe("logs");
});





