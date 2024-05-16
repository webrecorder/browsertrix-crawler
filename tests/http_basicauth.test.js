import child_process from "child_process";
import fs from "fs";
import http from 'http';

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.write("Hi!");
  res.end();
});

beforeAll(() => {
  server.listen(9998, '0.0.0.0');
});

test("test that http basic auth works", async () => {

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://host.docker.internal:9998/ --httpBasicAuth foo:bar --collection basicauth-test --statsFilename stats.json",
  );

  const data = fs.readFileSync("test-crawls/stats.json", "utf8");
  const dataJSON = JSON.parse(data);
  expect(dataJSON.crawled).toEqual(1);
  expect(dataJSON.failed).toEqual(0);
});

afterAll(() => {
  server.close();
})
