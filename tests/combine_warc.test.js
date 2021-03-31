const fs = require("fs");
const path = require("path");

test("check that a combined warc file exists in the archive folder", () => {
  const warcLists = fs.readdirSync("crawls/collections/wr-net");
  var captureFound = 0;
  
  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].includes("combined") && warcLists[i].endsWith(".warc")){
      captureFound = 1;
    }
  }
  expect(captureFound).toEqual(1);
});
