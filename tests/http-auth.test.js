import { execSync, spawn } from "child_process";
import fs from "fs";
import yaml from "js-yaml";

let proc = null;

const DOCKER_HOST_NAME = process.env.DOCKER_HOST_NAME || "host.docker.internal";

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
  expect(status).toBe(17);
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

test("run crawl with auth config.yaml", () => {
  const config = {
    seeds: [{
      url: `http://${DOCKER_HOST_NAME}:31501`,
      auth: "user:pass"
    }],
    limit: "2",
    collection: "http-auth-test-2",
    failOnFailedSeed: "true"
  }

  const configYaml = yaml.dump(config);

  let status = 0;
  try {
    execSync("docker run -i --rm -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --config stdin",
      { input: configYaml, stdin: "inherit", encoding: "utf8" });

  } catch (e) {
    console.log(e);
    status = e.status;
  }

  expect(status).toBe(0);

   expect(fs
    .readFileSync(
      "test-crawls/collections/http-auth-test-2/pages/pages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n")
    .length).toBe(2);

  expect(fs
    .readFileSync(
      "test-crawls/collections/http-auth-test-2/pages/extraPages.jsonl",
      "utf8",
    )
    .trim()
    .split("\n")
    .length).toBe(2);
});
