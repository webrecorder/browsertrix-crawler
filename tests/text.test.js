const fs = require("fs");
const md5 = require('md5');


test('check that the pages.jsonl file exists in the collection under the pages folder', () => {
  expect(fs.existsSync('crawls/collections/wr-net/pages/pages.jsonl')).toBe(true);
});

test('check that the pages.jsonl file exists in the wacz under the pages folder', () => {
  expect(fs.existsSync('crawls/collections/wr-net/wacz/pages/pages.jsonl')).toBe(true);
});

test('check that the hash in the pages folder and in the unzipped wacz folders match', () => {
  
  fs.readFile('crawls/collections/wr-net/wacz/pages/pages.jsonl', function(err, buf) {
    var browsertrix_hash = md5(buf);
  });
  
  fs.readFile('crawls/collections/wr-net/wacz/pages/pages.jsonl', function(err, buf) {
    var wacz_hash = md5(buf);
  });
  
  expect(browsertrix_hash).toBe(wacz_hash);
});

test('check that the fixture hash matches both of the other hashes', () => {
  
  fs.readFile('tests/fixtures/pages.jsonl', function(err, buf) {
    var fixture_hash = md5(buf);
  });
  
  fs.readFile('crawls/collections/wr-net/wacz/pages/pages.jsonl', function(err, buf) {
    var browsertrix_hash = md5(buf);
  });
  
  fs.readFile('crawls/collections/wr-net/wacz/pages/pages.jsonl', function(err, buf) {
    var wacz_hash = md5(buf);
  });
  
  expect(browsertrix_hash).toBe(wacz_hash);
  expect(browsertrix_hash).toBe(fixture_hash);
  expect(wacz_hash).toBe(fixture_hash);
});
