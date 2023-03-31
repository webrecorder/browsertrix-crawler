import child_process from "child_process";
import fs from "fs";
import path from "path";


function jsonLinesToArray(string) {
  return string.split("\n")
    .filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch (error) {
        return false;
      }
    })
    .map(line => JSON.parse(line));
}


test("ensure crawl run with log options passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://specs.webrecorder.net --generateWACZ --collection wr-specs-logs --scopeType domain --extraHops 1 --limit 20 --logging debug,stats --logLevel debug,warn --context general");
});


test("check that log files exist and were filtered according to options", () => {
  const logDir = "test-crawls/collections/wr-specs-logs/logs/";
  const logFiles = [];
  fs.readdirSync(logDir).forEach(file => {
    if (file.startsWith("crawl-") && file.endsWith(".log")) {
      logFiles.push(path.join(logDir, file));
    }
  });

  expect(logFiles.length).toBeGreaterThan(0);

  for (let i=0; i < logFiles.length; i++) {
    const logFile = logFiles[i];
    const parsedJSONLines = jsonLinesToArray(fs.readFileSync(logFile, "utf8"));

    expect(parsedJSONLines.length).toBeGreaterThan(0);

    parsedJSONLines.forEach((jsonLine) => {
      expect(jsonLine.logLevel === "debug" || jsonLine.logLevel === "warn").toBe(true);
      expect(jsonLine.context).toBe("general");
    });
  }
});
