import child_process from "child_process";

test("test custom behaviors from local filepath", async () => {
  const res = child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://example.org/ --url https://old.webrecorder.net/ --customBehaviors /custom-behaviors/ --scopeType page",
  );

  const log = res.toString();

  // custom behavior ran for specs.webrecorder.net
  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat","page":"https://specs.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // but not for example.org
  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat","page":"https://example.org/","workerid":0}}',
    ) > 0,
  ).toBe(false);

  expect(
    log.indexOf(
      '{"state":{"segments":1},"msg":"Skipping autoscroll, page seems to not be responsive to scrolling events","page":"https://example.org/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // another custom behavior ran for old.webrecorder.net
  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat-2","page":"https://old.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test custom behavior from URL", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --customBehaviors https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/refs/heads/main/tests/custom-behaviors/custom-2.js --scopeType page");

  const log = res.toString();

  expect(log.indexOf("Custom behavior file downloaded") > 0).toBe(true);

  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat-2","page":"https://webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);
});

test("test mixed custom behavior sources", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://webrecorder.net/ --customBehaviors https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/refs/heads/main/tests/custom-behaviors/custom-2.js --customBehaviors /custom-behaviors/custom.js --scopeType page");

  const log = res.toString();

  // test custom behavior from url ran
  expect(log.indexOf("Custom behavior file downloaded") > 0).toBe(true);

  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat","page":"https://specs.webrecorder.net/","workerid":0}}',
    ) > 0,
  ).toBe(true);

  // test custom behavior from local file ran
  expect(
    log.indexOf(
      '{"state":{},"msg":"test-stat-2","page":"https://webrecorder.net/","workerid":0}}',
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
