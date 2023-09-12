import child_process from "child_process";

test("test custom behaviors", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url --url https://webrecorder.net/ --customBehaviors 'https://raw.githubusercontent.com/webrecorder/browsertrix-behaviors/main/dist/behaviors.js' --scopeType page");

  const log = res.toString();

  expect(log.indexOf("{\"state\":{\"segments\":1},\"msg\":\"Skipping autoscroll, page seems to not be responsive to scrolling events\",\"page\":\"https://webrecorder.net/\",\"workerid\":0}") > 0).toBe(true);
});
