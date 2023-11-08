import util from "util";
import { exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

test("check that the collection name is properly validated", async () => {
  let passed = "";

  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --collection valid_collection-nameisvalid",
    );
    passed = true;
  } catch (error) {
    passed = false;
  }
  expect(passed).toBe(true);
});

test("check that the collection name is not accepted if it doesn't meets our standards", async () => {
  let passed = "";

  try {
    await exec(
      "docker run webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --collection invalid_c!!ollection-nameisvalid",
    );
    passed = true;
  } catch (e) {
    passed = false;
  }
  expect(passed).toBe(false);
});
