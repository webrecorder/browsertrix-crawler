const fs = require("fs");
const md5 = require('md5');


test('check that the pages.jsonl file exists in the collection under the pages folder', () => {
  expect(fs.existsSync('collections/wr-net/pages/pages.jsonl')).toBe(true);
});

test('check that the pages.jsonl file exists in the wacz under the pages folder', () => {
  expect(fs.existsSync('collections/wr-net/wacz/pages/pages.jsonl')).toBe(true);
});

test('check that the hash in the pages folder and in the unzipped wacz folders match', () => {
  const browsertrix_hash = md5(fs.readFileSync('collections/wr-net/wacz/pages/pages.jsonl', 'utf8'))
  const wacz_hash = md5(fs.readFileSync('collections/wr-net/wacz/pages/pages.jsonl', 'utf8'))

  expect(browsertrix_hash).toEqual(wacz_hash);
});

test('check that the fixture hash matches both of the other hashes', () => {
   const fixture_hash = md5(fs.readFileSync('tests/fixtures/pages.jsonl', 'utf8'))
   const browsertrix_hash = md5(fs.readFileSync('collections/wr-net/wacz/pages/pages.jsonl', 'utf8'))
   const wacz_hash = md5(fs.readFileSync('collections/wr-net/wacz/pages/pages.jsonl', 'utf8'))

  expect(browsertrix_hash).toEqual(wacz_hash);
  expect(browsertrix_hash).toEqual(fixture_hash);
  expect(wacz_hash).toEqual(fixture_hash);
});
