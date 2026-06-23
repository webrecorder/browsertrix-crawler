import { execSync } from "child_process";
import { ErrorWithStatus } from "./utils";

test("run crawl with invalid lang", () => {
  let status = 0;
  try {
    execSync(
      `docker run --rm webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/feed.xml --lang e --limit 1`,
    );
  } catch (e) {
    status = (e as ErrorWithStatus).status;
  }
  expect(status).toBe(17);
});

test("run crawl with valid lang", () => {
  let status = 0;
  try {
    execSync(
      `docker run --rm webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/feed.xml --lang en --limit 1`,
    );
  } catch (e) {
    status = (e as ErrorWithStatus).status;
  }
  expect(status).toBe(0);
});
