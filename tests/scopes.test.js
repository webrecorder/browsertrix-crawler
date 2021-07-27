const { parseArgs } = require("../util/argParser");

const fs = require("fs");

function getSeeds(config) {
  const orig = fs.readFileSync;

  fs.readFileSync = (name, ...args) => {
    if (name.endsWith("/stdinconfig")) {
      return config;
    }
    return orig(name, ...args);
  };

  const res = parseArgs(["node", "crawler", "--config", "stdinconfig"]);
  return res.parsed.scopedSeeds;
}

test("default scope", async () => {
  const seeds = getSeeds(`
seeds:
   - https://example.com/

`);


  expect(seeds.length).toEqual(1);
  expect(seeds[0].scopeType).toEqual("prefix");
  expect(seeds[0].include).toEqual([/^https:\/\/example\.com\//]);
  expect(seeds[0].exclude).toEqual([]);

});

test("custom scope", async () => {
  const seeds = getSeeds(`
seeds:
   - url: https://example.com/
     include: https://example.com/(path|other)
     exclude: https://example.com/pathexclude
`);


  expect(seeds.length).toEqual(1);
  expect(seeds[0].scopeType).toEqual("custom");
  expect(seeds[0].include).toEqual([/https:\/\/example.com\/(path|other)/]);
  expect(seeds[0].exclude).toEqual([/https:\/\/example.com\/pathexclude/]);
});


test("inherit scope", async () => {
  const seeds = getSeeds(`

seeds:
   - url: https://example.com/1
   - url: https://example.com/2

include: https://example.com/(path|other)
exclude: https://example.com/pathexclude
`);


  expect(seeds.length).toEqual(2);

  expect(seeds[0].scopeType).toEqual("custom");
  expect(seeds[0].url).toEqual("https://example.com/1");
  expect(seeds[0].include).toEqual([/https:\/\/example.com\/(path|other)/]);
  expect(seeds[0].exclude).toEqual([/https:\/\/example.com\/pathexclude/]);

  expect(seeds[1].scopeType).toEqual("custom");
  expect(seeds[1].url).toEqual("https://example.com/2");
  expect(seeds[1].include).toEqual([/https:\/\/example.com\/(path|other)/]);
  expect(seeds[1].exclude).toEqual([/https:\/\/example.com\/pathexclude/]);

});


test("override scope", async () => {
  const seeds = getSeeds(`

seeds:
   - url: https://example.com/1
     include: https://example.com/(path|other)

   - https://example.com/2

   - url: https://example.com/subpath/file.html
     scopeType: prefix

include: https://example.com/onlythispath
`);

  expect(seeds.length).toEqual(3);

  expect(seeds[0].scopeType).toEqual("custom");
  expect(seeds[0].url).toEqual("https://example.com/1");
  expect(seeds[0].include).toEqual([/https:\/\/example.com\/(path|other)/]);
  expect(seeds[0].exclude).toEqual([]);

  expect(seeds[1].scopeType).toEqual("custom");
  expect(seeds[1].url).toEqual("https://example.com/2");
  expect(seeds[1].include).toEqual([/https:\/\/example.com\/onlythispath/]);
  expect(seeds[1].exclude).toEqual([]);

  expect(seeds[2].scopeType).toEqual("prefix");
  expect(seeds[2].url).toEqual("https://example.com/subpath/file.html");
  expect(seeds[2].include).toEqual([/^https:\/\/example\.com\/subpath\//]);
  expect(seeds[2].exclude).toEqual([]);

});


test("override scope with exclude", async () => {
  const seeds = getSeeds(`

seeds:
   - url: https://example.com/1
     scopeType: page-spa

   - url: https://example.com/subpath/file.html
     scopeType: prefix

   - url: https://example.com/2
     scopeType: any

   - url: https://example.com/3
     scopeType: page

   - url: https://example.com/4
     scopeType: page
     exclude: ''

exclude:
  - /search\\?
  - q\\?

`);

  expect(seeds.length).toEqual(5);
  const excludeRxs = [/\/search\?/, /q\?/];

  expect(seeds[0].scopeType).toEqual("page-spa");
  expect(seeds[0].url).toEqual("https://example.com/1");
  expect(seeds[0].include).toEqual([/^https?:\/\/example\.com\/1#.+/]);
  expect(seeds[0].exclude).toEqual(excludeRxs);

  expect(seeds[1].scopeType).toEqual("prefix");
  expect(seeds[1].url).toEqual("https://example.com/subpath/file.html");
  expect(seeds[1].include).toEqual([/^https:\/\/example\.com\/subpath\//]);
  expect(seeds[1].exclude).toEqual(excludeRxs);

  expect(seeds[2].scopeType).toEqual("any");
  expect(seeds[2].url).toEqual("https://example.com/2");
  expect(seeds[2].include).toEqual([/.*/]);
  expect(seeds[2].exclude).toEqual(excludeRxs);

  expect(seeds[3].scopeType).toEqual("page");
  expect(seeds[3].url).toEqual("https://example.com/3");
  expect(seeds[3].include).toEqual([]);
  expect(seeds[3].exclude).toEqual(excludeRxs);

  expect(seeds[4].scopeType).toEqual("page");
  expect(seeds[4].url).toEqual("https://example.com/4");
  expect(seeds[4].include).toEqual([]);
  expect(seeds[4].exclude).toEqual([]);

});

