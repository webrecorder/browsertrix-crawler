const fs = require("fs");

test("check that a combined warc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("crawls/collections/wr-net");
  var captureFound = 0;
  
  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith("_0.warc")){
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});
