const { parseArgs } = require("../util/argParser");

fs = require("fs");

function getSeeds(config) {
  const orig = fs.readFileSync;

  fs.readFileSync = (name, ...args) => {
    if (name.endsWith("/configtest")) {
      return config;
    }
    return orig(name, ...args);
  }

  return parseArgs(null, ["node", "crawler", "--config", "configtest"]).scopedSeeds;
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




