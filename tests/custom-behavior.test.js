import child_process from "child_process";

test("test custom behaviors", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --url https://example.org/ --url https://webrecorder.net/ --customBehaviors /custom-behaviors/ --scopeType page");

  const log = res.toString();

  // custom behavior ran for example.com
  expect(log.indexOf("{\"state\":{},\"msg\":\"test-stat\",\"page\":\"https://example.com/\",\"workerid\":0}}") > 0).toBe(true);

  // but not for example.org
  expect(log.indexOf("{\"state\":{},\"msg\":\"test-stat\",\"page\":\"https://example.org/\",\"workerid\":0}}") > 0).toBe(false);

  expect(log.indexOf("{\"state\":{\"segments\":1},\"msg\":\"Skipping autoscroll, page seems to not be responsive to scrolling events\",\"page\":\"https://example.org/\",\"workerid\":0}}") > 0).toBe(true);

  // another custom behavior ran for webrecorder.net
  expect(log.indexOf("{\"state\":{},\"msg\":\"test-stat-2\",\"page\":\"https://webrecorder.net/\",\"workerid\":0}}") > 0).toBe(true);



});


