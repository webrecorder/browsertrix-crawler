import util from "util";
import { exec as execCallback } from "child_process";

const exec = util.promisify(execCallback);

test("ensure URLs with array-valued headers succeed without multiValueHeader errors", async () => {
  // Facebook and other sites return array-valued headers that aren't in the
  // multiValueHeader allowed list (set-cookie, warc-concurrent-to, warc-protocol)
  // This test verifies that such headers are properly joined with ", " instead of
  // throwing "not a valid multi value header" error
  let passed = true;
  let output = "";
  try {
    const result = await exec(
      "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://www.facebook.com/permalink.php?story_fbid=pfbid0BqNZHQaQfqTAKzVaaeeYNuyPXFJhkPmzwWT7mZPZJLFnHNEvsdbnLJRPkHJDMcqFl&id=100082135548177 --scopeType page --limit 1 --collection multivalueheadertest",
    );
    output = result.stdout + result.stderr;
  } catch (error) {
    console.log(error);
    output = error.stdout + error.stderr;
    passed = false;
  }

  // Should not contain the multiValueHeader error
  expect(output).not.toContain("not a valid multi value header");

  // Should successfully crawl at least one page
  expect(output).toMatch(/crawled:\s+1/);

  expect(passed).toBe(true);
});
