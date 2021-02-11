//const autoplayScript = require("/app/autoplay.js");

/* eslint-disable no-undef */

module.exports = async ({data, page, crawler}) => {
  const {url} = data;

  if (!await crawler.isHTML(url)) {
    await crawler.directFetchCapture(url);
    return;
  }

  const gotoOpts = {
    waitUntil: crawler.params.waitUntil,
    timeout: crawler.params.timeout
  };

  try {
    console.log("Wait page load...");
    await page.goto(url, gotoOpts);
    console.log("Done");
  } catch (e) {
    console.log(`Load timeout for ${url}`, e);
  }

  await crawler.extractLinks(page, "a[href]");
};

