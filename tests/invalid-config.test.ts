import { execSync } from "node:child_process";
import { ErrorWithStatus } from "./utils";

const INVALID_CONFIG = 4;

// Note other invalid config options are tested in lang-code.test.ts and custom_selector.test.ts

function runGetError(cmd: string) {
  let error = 0;
  try {
    execSync(cmd);
  } catch (e) {
    error = (e as ErrorWithStatus).status;
  }
  return error;
}

test("invalid collection name ", async () => {
  expect(
    runGetError(
      "docker run --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --collection %foo#",
    ),
  ).toBe(INVALID_CONFIG);
});

test("invalid device + restartsOnError not applicable here ", async () => {
  expect(
    runGetError(
      "docker run --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --mobileDevice blah --restartsOnError",
    ),
  ).toBe(INVALID_CONFIG);
});

test("invalid redis URL ", async () => {
  expect(
    runGetError(
      "docker run --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --redisStoreUrl https://redis",
    ),
  ).toBe(INVALID_CONFIG);
});
