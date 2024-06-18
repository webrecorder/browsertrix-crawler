import { execSync, spawn } from "child_process";

let proc = null;

beforeAll(() => {
  console.log(`Server Host: ${process.env.SERVER_HOST}`);
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
    execSync(`docker run --rm webrecorder/browsertrix-crawler crawl --url http://${process.env.SERVER_HOST}:31501 --limit 2 --failOnFailedSeed`);
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(1);
});

test("run crawl with auth", () => {
  let status = 0;
  try {
    execSync(`docker run --rm webrecorder/browsertrix-crawler crawl --url http://user:pass@${process.env.SERVER_HOST}:31501 --limit 2 --failOnFailedSeed`, {stdio: "inherit"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(0);
});
