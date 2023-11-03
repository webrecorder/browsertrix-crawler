import { exec } from "child_process";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import Redis from "ioredis";

function waitForProcess() {
  let callback = null;
  const p = new Promise((resolve) => {
    callback = (/*error, stdout, stderr*/) => {
      //console.log(stdout);
      resolve(0);
    };
  });

  return {p, callback};
}

var savedStateFile;
var state;
var numDone;
var redis;
var finishProcess;

test("check crawl interrupted + saved state written", async () => {
  let proc = null;

  const wait = waitForProcess();

  try {
    proc = exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://webrecorder.net/ --limit 20", {"shell": "/bin/bash"}, wait.callback);
  }
  catch (error) {
    console.log(error);
  }

  const pagesFile = "test-crawls/collections/int-state-test/pages/pages.jsonl";

  // remove existing pagesFile to support reentrancy
  try {
    fs.unlinkSync(pagesFile);
  } catch (e) {
    // ignore
  }

  while (true) {
    try {
      const pages = fs.readFileSync(pagesFile, {encoding: "utf-8"}).trim().split("\n");

      if (pages.length >= 2) {
        break;
      }
    } catch(e) {
      // ignore
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  proc.kill("SIGINT");

  await wait.p;

  const savedStates = fs.readdirSync("test-crawls/collections/int-state-test/crawls");
  expect(savedStates.length > 0).toEqual(true);

  savedStateFile = savedStates[savedStates.length - 1];
});


test("check parsing saved state + page done + queue present", () => {
  expect(savedStateFile).toBeTruthy();

  const savedState = fs.readFileSync(path.join("test-crawls/collections/int-state-test/crawls", savedStateFile), "utf-8");
  
  const saved = yaml.load(savedState);

  expect(!!saved.state).toBe(true);
  state = saved.state;

  numDone = state.done;

  expect(state.done > 0).toEqual(true);
  expect(state.queued.length > 0).toEqual(true);

});


test("check crawl restarted with saved state", async () => {
  let proc = null;

  const wait = waitForProcess();

  try {
    proc = exec(`docker run -p 36379:6379 -e CRAWL_ID=test -v $PWD/test-crawls:/crawls -v $PWD/tests/fixtures:/tests/fixtures webrecorder/browsertrix-crawler crawl --collection int-state-test --url https://webrecorder.net/ --config /crawls/collections/int-state-test/crawls/${savedStateFile} --debugAccessRedis --limit 5`, {shell: "/bin/bash"}, wait.callback);
  }
  catch (error) {
    console.log(error);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  redis = new Redis("redis://127.0.0.1:36379/0", {lazyConnect: true});

  try {

    await redis.connect({maxRetriesPerRequest: 100});

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(await redis.get("test:d")).toBe(numDone + "");
  } finally {
    proc.kill("SIGINT");
  }

  finishProcess = wait.p;
});

test("interrupt crawl and exit", async () => {
  const res = await Promise.allSettled([finishProcess, redis.quit()]);

  expect(res[0].value).toBe(0);
});


