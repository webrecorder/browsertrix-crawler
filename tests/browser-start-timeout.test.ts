import { execSync } from "child_process";
import { ErrorWithStatus } from "./utils";

// exit code used by logger.fatal() when not restarting on error
const FATAL = 17;

function runCrawl(extraArgs: string): { status: number; output: string } {
  let status = 0;
  let output = "";
  try {
    output = execSync(
      `docker run --rm webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --limit 1 ${extraArgs}`,
      { encoding: "utf-8", stdio: "pipe" },
    );
  } catch (e) {
    status = (e as ErrorWithStatus).status;
    const err = e as ErrorWithStatus & { stdout?: Buffer; stderr?: Buffer };
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return { status, output };
}

test("crawl succeeds with a raised --browserStartTimeout", () => {
  const { status } = runCrawl("--browserStartTimeout 120");
  expect(status).toBe(0);
});

test("invalid --browserStartTimeout falls back to the default, crawl still runs", () => {
  const { status } = runCrawl("--browserStartTimeout 0");
  expect(status).toBe(0);
});

test("crawl fails with an actionable message when browser startup times out", () => {
  // 0.001s -> 1ms, browser cannot start that fast, must hit the timeout
  const { status, output } = runCrawl("--browserStartTimeout 0.001");
  expect(status).toBe(FATAL);
  expect(output).toContain("--browserStartTimeout");
});
