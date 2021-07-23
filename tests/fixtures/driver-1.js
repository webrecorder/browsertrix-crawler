module.exports = async ({data, page, crawler}) => {
  await crawler.loadPage(page, data, {selector: "script[src]", extract: "src", isAttribute: false});
};

/*
module.exports = async ({data, page, crawler}) => {
  await crawler.loadPage(page, data);
  const {seedId, depth} = data;

  const links = await crawler.extractLinks(page, {selector: "figure.file", extract: "data-url", isAttribute: true});

  for (const link of links) {
    console.log("got link " + link);
    // allow filtering any links here as needed
    crawler.queueUrl(seedId, link, depth + 1);
  }
};
*/
