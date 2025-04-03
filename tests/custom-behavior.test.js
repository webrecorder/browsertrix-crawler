import child_process from "child_process";
import Redis from "ioredis";


async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time));
}


test("test custom behaviors from local filepath", async () => {
  const res = child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://example.org/ --url https://old.webrecorder.net/ --customBehaviors /custom-behaviors/ --scopeType page",
  );

  const log = res.toString();

  // custom behavior ran for specs.webrecorder.net
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat","details":{"state":{},"behavior":"TestBehavior","page":"https://specs.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // but not for example.org
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat","details":{"state":{},"behavior":"TestBehavior","page":"https://example.org","workerid":0}}',
    ) > 0,
  ).toBe(false);

  // another custom behavior ran for old.webrecorder.net
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat-2","details":{"state":{},"behavior":"TestBehavior2","page":"https://old.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test custom behavior from URL", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --customBehaviors https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/refs/heads/main/tests/custom-behaviors/custom-2.js --scopeType page");

  const log = res.toString();

  expect(log.indexOf("Custom behavior file downloaded") > 0).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat-2","details":{"state":{},"behavior":"TestBehavior2","page":"https://old.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test mixed custom behavior sources", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://old.webrecorder.net/ --customBehaviors https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/refs/heads/main/tests/custom-behaviors/custom-2.js --customBehaviors /custom-behaviors/custom.js --scopeType page");

  const log = res.toString();

  // test custom behavior from url ran
  expect(log.indexOf("Custom behavior file downloaded") > 0).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat","details":{"state":{},"behavior":"TestBehavior","page":"https://specs.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // test custom behavior from local file ran
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat-2","details":{"state":{},"behavior":"TestBehavior2","page":"https://old.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test custom behaviors from git repo", async () => {
  const res = child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://example.org/ --url https://old.webrecorder.net/ --customBehaviors \"git+https://github.com/webrecorder/browsertrix-crawler.git?branch=main&path=tests/custom-behaviors\" --scopeType page",
  );

  const log = res.toString();

  // custom behavior ran for specs.webrecorder.net
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat","details":{"state":{},"behavior":"TestBehavior","page":"https://specs.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // but not for example.org
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat","details":{"state":{},"behavior":"TestBehavior","page":"https://example.org/","workerid":0}}',
    ) > 0,
  ).toBe(false);

  // another custom behavior ran for old.webrecorder.net
  expect(
    log.indexOf(
      '"logLevel":"info","context":"behaviorScriptCustom","message":"test-stat-2","details":{"state":{},"behavior":"TestBehavior2","page":"https://old.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test invalid behavior exit", async () => {
  let status = 0;

  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/invalid-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --url https://example.org/ --url https://old.webrecorder.net/ --customBehaviors /custom-behaviors/invalid-export.js --scopeType page",
    );
  } catch (e) {
    status = e.status;
  }

  // logger fatal exit code
  expect(status).toBe(17);
});

test("test crawl exits if behavior not fetched from url", async () => {
  let status = 0;

  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com --customBehaviors https://webrecorder.net/doesntexist/custombehavior.js --scopeType page",
    );
  } catch (e) {
    status = e.status;
  }

  // logger fatal exit code
  expect(status).toBe(17);
});

test("test crawl exits if behavior not fetched from git repo", async () => {
  let status = 0;

  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com --customBehaviors git+https://github.com/webrecorder/doesntexist --scopeType page",
    );
  } catch (e) {
    status = e.status;
  }

  // logger fatal exit code
  expect(status).toBe(17);
});

test("test crawl exits if not custom behaviors collected from local path", async () => {
  let status = 0;

  try {
    child_process.execSync(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com --customBehaviors /custom-behaviors/doesntexist --scopeType page",
    );
  } catch (e) {
    status = e.status;
  }

  // logger fatal exit code
  expect(status).toBe(17);
});

test("test pushing behavior logs to redis", async () => {
  const child = child_process.exec("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ -e CRAWL_ID=behavior-logs-redis-test -p 36399:6379 --rm webrecorder/browsertrix-crawler crawl --debugAccessRedis --url https://specs.webrecorder.net/ --url https://old.webrecorder.net/ --customBehaviors https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/refs/heads/main/tests/custom-behaviors/custom-2.js --customBehaviors /custom-behaviors/custom.js --scopeType page --logBehaviorsToRedis");

  let resolve = null;
  const crawlFinished = new Promise(r => resolve = r);

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
    resolve();
  });

  const redis = new Redis("redis://127.0.0.1:36399/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let customLogLineCount = 0;

  while (!crawler_exited) {
    try {
      const res = await redis.lpop("behavior-logs-redis-test:b");
      if (!res) {
        await sleep(100);
        continue;
      }
      const json = JSON.parse(res);
      expect(json).toHaveProperty("timestamp");
      expect(json.logLevel).toBe("info");
      expect(["behavior", "behaviorScript", "behaviorScriptCustom"]).toContain(json.context)

      if (json.context === "behaviorScriptCustom") {
        expect(["test-stat", "test-stat-2", "done!"]).toContain(json.message);
        expect(["TestBehavior", "TestBehavior2"]).toContain(json.details.behavior);
        expect(["https://specs.webrecorder.net/", "https://old.webrecorder.net/"]).toContain(json.details.page);
        customLogLineCount++;
      }
    } catch (e) {
      break;
    }
    
  }

  expect(customLogLineCount).toBeGreaterThanOrEqual(2);
});
