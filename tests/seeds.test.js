import util from "util";
import { exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

test("ensure one invalid seed doesn't end crawl if failOnFailedSeed is not set", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url https://example.invalid --generateWACZ --limit 1 --collection invalidseed",
    );
  } catch (error) {
    console.log(error);
    passed = false;
  }
  expect(passed).toBe(true);
});

test("ensure one invalid seed fails crawl if failOnFailedSeed is set", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url example.invalid --generateWACZ --limit 1 --failOnFailedSeed --collection failseed",
    );
  } catch (error) {
    expect(error.code).toEqual(1);
    passed = false;
  }
  expect(passed).toBe(false);
});

test("ensure seed with network error fails crawl if failOnFailedSeed and failOnInvalidStatus is set", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url https://example.invalid --generateWACZ --limit 2 --failOnFailedSeed --failOnInvalidStatus --collection failseedstatus",
    );
  } catch (error) {
    expect(error.code).toEqual(1);
    passed = false;
  }
  expect(passed).toBe(false);
});

test("ensure seed with 4xx/5xx response fails crawl if failOnFailedSeed and failOnInvalidStatus are set", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url https://webrecorder.net/404 --generateWACZ --limit 2 --failOnFailedSeed --failOnInvalidStatus --collection failseed404status",
    );
  } catch (error) {
    expect(error.code).toEqual(1);
    passed = false;
  }
  expect(passed).toBe(false);
});

test("ensure seed with 4xx/5xx response succeeds if failOnInvalidStatus is not set", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.iana.org/ --url https://webrecorder.net/404 --generateWACZ --limit 2 --failOnFailedSeed --collection failseedwithoutinvalidstatus",
    );
  } catch (error) {
    console.log(error);
    passed = false;
  }
  expect(passed).toBe(true);
});

test("ensure crawl fails if no valid seeds are passed", async () => {
  let passed = true;
  try {
    await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url iana.org/ --url example.invalid --generateWACZ --limit 2 --collection allinvalidseeds",
    );
  } catch (error) {
    expect(error.code).toEqual(17);
    passed = false;
  }
  expect(passed).toBe(false);
});
