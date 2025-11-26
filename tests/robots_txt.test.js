import child_process from "child_process";

test("test robots.txt is fetched and cached", async () => {
  const res = child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net/ --url https://webrecorder.net/ --scopeType page --robots --logging debug",
  );

  const log = res.toString();

  // robots.txt not found
  expect(
    log.indexOf(
      '"logLevel":"debug","context":"robots","message":"Fetching robots.txt","details":{"url":"https://specs.webrecorder.net/robots.txt"}}',
    ) > 0,
  ).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"debug","context":"robots","message":"Robots.txt invalid, storing empty value","details":{"url":"https://specs.webrecorder.net/robots.txt","status":404}}',
    ) > 0,
  ).toBe(true);

  // robots.txt found and cached
  expect(
    log.indexOf(
      '"logLevel":"debug","context":"robots","message":"Fetching robots.txt","details":{"url":"https://webrecorder.net/robots.txt"}}',
    ) > 0,
  ).toBe(true);

  expect(
    log.indexOf(
      '"logLevel":"debug","context":"robots","message":"Caching robots.txt body","details":{"url":"https://webrecorder.net/robots.txt"}}',
    ) > 0,
  ).toBe(true);
});
