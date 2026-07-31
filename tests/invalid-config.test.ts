import { execSync } from "node:child_process";

const INVALID_CONFIG = 4;

function runGetError(cmd: string) {
  let error = 0;
  try {
    execSync(cmd);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    error = e.status || 999;
  }
  return error;
}

test("invalid css selector ", async () => {
  expect(
    runGetError(
      "docker run --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --selectLinks 'div[2]->body'",
    ),
  ).toBe(INVALID_CONFIG);
});

test("click selector + restartsOnError not applicable here ", async () => {
  expect(
    runGetError(
      "docker run --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --clickSelector 'div[3]' --restartsOnError",
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
