const fs = require("fs");
const path = require("path");

function getFileSize(filename) {
  var stats = fs.statSync(filename);
  return stats.size;
}

test("check that a combined warc file is under the rolloverSize", () => {
  const warcLists = fs.readdirSync(path.join("crawls/collections/wr-net/wacz", "archive"));
  var rolloverSize = 0;
  
  for (var i = 0; i < warcLists.length; i++) {
    var size = getFileSize(path.join("crawls/collections/wr-net/wacz/archive/", warcLists[i]));
    if (size < 10000){
      rolloverSize = 1;
    }
  }
  expect(rolloverSize).toEqual(1);
});