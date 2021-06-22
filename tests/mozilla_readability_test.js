const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");

test("verify that Mozilla's Readibility.js extracts a boilerplate-free text", async () => {
  jest.setTimeout(30000);

  try {
    await exec("docker-compose run crawler crawl --collection readibilitytest --url https://www.iana.org/about --timeout 10000 --text --readerView --limit 1");
  }
  catch (error) {
    console.log(error);
  }

  const page = JSON.parse(fs.readFileSync("crawls/collections/readibilitytest/pages/pages.jsonl",
    "utf8").split("\n")[1]);
  console.log("title:", page.article.title, "\nexcerpt:", page.article.excerpt);

  // test whether excerpt is present
  expect(page.article.excerpt.length > 0).toBe(true);
  // test whether boilerplate-free text is shorter than DOM-constructed text
  expect(page.article.textContent.length < page.text.length).toBe(true);
});
