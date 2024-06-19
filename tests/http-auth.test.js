import { execSync, spawn } from "child_process";
import fs from "fs";

let proc = null;

const DOCKER_HOST_NAME = "host.docker.internal";

beforeAll(() => {
  proc = spawn("../../node_modules/.bin/http-server", ["-p", "31501", "--username", "user", "--password", "pass"], {cwd: "./docs/site"});
});

afterAll(() => {
  if (proc) {
    proc.kill();
  }
});

test("run crawl without auth", () => {
  let status = 0;
  try {
    execSync(`docker run --rm webrecorder/browsertrix-crawler crawl --url http://${DOCKER_HOST_NAME}:31501 --limit 2 --failOnFailedSeed`);
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(1);
});

test("run crawl with auth", () => {
  let status = 0;
  try {
    execSync(`docker run --rm -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://user:pass@${DOCKER_HOST_NAME}:31501 --limit 2 --failOnFailedSeed --collection http-auth-test`);
  } catch (e) {
    status = e.status;
  }

  expect(status).toBe(0);

  expect(fs
    .readFileSync(
      "test-crawls/collections/http-auth-test/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n")
    .length).toBe(2);

  expect(fs
    .readFileSync(
      "test-crawls/collections/http-auth-test/pages/extraPages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n")
    .length).toBe(2);

});
