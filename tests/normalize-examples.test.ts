import { normalizeUrl, normalizedRedirectSeedUrl } from "../src/util/normalize";

test("normalize url: normalize case and arg order", async () => {
  expect(
    normalizeUrl("https://WWW.example.com/path/somefile.html?B=2&A=1"),
  ).toBe("https://www.example.com/path/somefile.html?A=1&B=2");
});

test("seed redirect: change in www. matches", async () => {
  expect(normalizedRedirectSeedUrl("https://www.example.com/")).toBe(
    normalizedRedirectSeedUrl("https://example.com/"),
  );
});

test("seed redirect: change in scheme matches", async () => {
  expect(normalizedRedirectSeedUrl("http://www3.example.com/")).toBe(
    normalizedRedirectSeedUrl("http://example.com/"),
  );
});

test("seed redirect: change in www. and scheme matches", async () => {
  expect(normalizedRedirectSeedUrl("https://www3.example.com/")).toBe(
    normalizedRedirectSeedUrl("http://example.com/"),
  );
});

test("seed redirect: change in tld, does not match", async () => {
  expect(
    normalizedRedirectSeedUrl("https://www3.example.org/path/some"),
  ).not.toBe(normalizedRedirectSeedUrl("http://example.com/path/some"));
});
