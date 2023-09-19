import child_process from "child_process";

test("test custom behaviors", async () => {
  const res = child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url --url https://webrecorder.net/ --customBehaviors 'https://raw.githubusercontent.com/webrecorder/browsertrix-behaviors/main/dist/behaviors.js' --scopeType page --behaviors \"\"");

  const log = res.toString();

  expect(log.indexOf("File downloaded to /app/behaviors/") > 0).toBe(true);
});
