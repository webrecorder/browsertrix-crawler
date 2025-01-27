import fs from "fs";
import { execSync } from "child_process";

// example.com includes a link to 'https://www.iana.org/domains/example' which redirects to 'https://www.iana.org/help/example-domains'
// pgae loading should be blocked on redirected due to exclusion of 'help', though the initial link is loaded

test("ensure exclusion is applied on redirected URL, which contains 'help', so it is not crawled", () => {
  execSync(
      "docker run -p 9037:9037 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com/ --exclude help --collection redir-exclude-test --extraHops 1");

  // no entries besides header
  expect(
    fs
      .readFileSync(
        "test-crawls/collections/retry-fail/pages/extraPages.jsonl",
        "utf8",
      ).trim().split("\n").length
  ).toBe(1);
  
});

