const fs = require("fs");
const path = require("path");

test('check that a combined warc file is under the rolloverSize', () => {
  const warcLists = fs.readdirSync(path.join('crawls/collections/wr-net/wacz', 'archive'));
  var rolloverSize = 0;
  
  for (var i = 0; i < warcLists.length; i++) {
    var size = fs.statSync(warcLists[i]).size;
    if (size < 10000){
      rolloverSize = 1;
    }
  }
  expect(rolloverSize).toEqual(1);
});