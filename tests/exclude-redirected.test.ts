import fs from "fs";
import { execSync } from "child_process";

// example.com includes a link to 'https://www.iana.org/domains/example' which redirects to 'https://www.iana.org/help/example-domains'
// pgae loading should be blocked on redirected due to exclusion of 'help', though the initial link is loaded

test("ensure exclusion is applied on redirected URL, which contains 'help', so it is not crawled", () => {
  execSync(
      "docker run --rm -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --exclude help --collection redir-exclude-test --extraHops 1");

  // no entries besides header
  expect(
    fs
      .readFileSync(
        "test-crawls/collections/redir-exclude-test/pages/extraPages.jsonl",
        "utf8",
      ).trim().split("\n").length
  ).toBe(1);
  
});


test("ensure exclusion applied on redirect URL, and URL is not requeued again", () => {
  execSync(
    "docker run --rm -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --exclude help --collection redir-exclude-test-2 --extraHops 1 --url https://www.iana.org/domains/example --url https://example-com.webrecorder.net/page-2 --generateCDX");


  // no entries besides header
  expect(
    fs
      .readFileSync(
        "test-crawls/collections/redir-exclude-test-2/pages/extraPages.jsonl",
        "utf8",
      ).trim().split("\n").length
  ).toBe(1);


  const data = fs.readFileSync(
    "test-crawls/collections/redir-exclude-test-2/indexes/index.cdxj",
    { encoding: "utf-8" },
  );

  // expect no urn:pageinfo records for excluded page
  const first = data.indexOf(`"urn:pageinfo:https://www.iana.org/domains/example"`);
  expect(first < 0).toBe(true);
});
