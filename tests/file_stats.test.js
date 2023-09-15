import child_process from "child_process";
import fs from "fs";

test("ensure that stats file is modified", async () => {

  const child = child_process.exec("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --generateWACZ  --text  --limit 3 --collection file-stats --statsFilename progress.json");

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function() {
    crawler_exited = true;
  });

  // helper function to sleep
  const sleep = ms => new Promise( res => setTimeout(res, ms));

  // wait for stats file creation up to 30 secs (to not wait indefinitely)
  let counter = 0;
  while (!fs.existsSync("test-crawls/progress.json")) {
    await sleep(100);
    counter++;
    expect(counter < 300).toBe(true);
  }

  // get initial modification time
  const initial_mtime = fs.fstatSync(fs.openSync("test-crawls/progress.json", "r")).mtime;

  // wait for crawler exit
  while (!crawler_exited) {
    await sleep(100);
  }

  // get final modification time
  const final_mtime = fs.fstatSync(fs.openSync("test-crawls/progress.json", "r")).mtime;

  // compare initial and final modification time
  const diff = Math.abs(final_mtime - initial_mtime);
  expect(diff > 0).toBe(true);

});

test("check that stats file format is correct", () => {
  const data = fs.readFileSync("test-crawls/progress.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(3);
  expect(dataJSON.total).toEqual(3);
  expect(dataJSON.pending).toEqual(0);
  expect(dataJSON.failed).toEqual(0);
  expect(dataJSON.limit.max).toEqual(3);
  expect(dataJSON.limit.hit).toBe(true);
  expect(dataJSON.pendingPages.length).toEqual(0);
});