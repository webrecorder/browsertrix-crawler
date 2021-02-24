const fs = require("fs");
const md5 = require('md5');


test('check that the pages.jsonl file exists in the collection under the pages folder', () => {
  expect(fs.existsSync('crawls/collections/wr-net/pages/pages.jsonl')).toBe(true);
});

test('check that the pages.jsonl file exists in the wacz under the pages folder', () => {
  expect(fs.existsSync('crawls/collections/wr-net/wacz/pages/pages.jsonl')).toBe(true);
});

test('check that the hash in the pages folder and in the unzipped wacz folders match', () => {
  const browsertrix_hash = md5(JSON.parse(fs.readFileSync('crawls/collections/wr-net/wacz/pages/pages.jsonl', 'utf8').split('\n')[1])['text']);
  const wacz_hash = md5(JSON.parse(fs.readFileSync('crawls/collections/wr-net/pages/pages.jsonl', 'utf8').split('\n')[1])['text']);
  const fixture_hash = md5(JSON.parse(fs.readFileSync('tests/fixtures/pages.jsonl', 'utf8').split('\n')[1])['text']);
  
  expect(wacz_hash).toEqual(fixture_hash);
  expect(wacz_hash).toEqual(browsertrix_hash);

});

