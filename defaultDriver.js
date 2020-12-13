const fs = require("fs");

const autoplayScript = fs.readFileSync("/app/autoplay.js", "utf-8");

const autofetchScript = fs.readFileSync("/app/autofetcher.js", "utf-8");

//const autoplayScript = require("/app/autoplay.js");

/* eslint-disable no-undef */

module.exports = async ({data, page, crawler}) => {
  const {url} = data;

  //page.on("requestfailed", message => console.warn(message._failureText));

  if (!await crawler.isHTML(url)) {
    await crawler.directFetchCapture(url);
    return;
  }

  if (crawler.emulateDevice) {
    await page.emulate(crawler.emulateDevice);
  }

  const mediaResults = [];

  await page.exposeFunction("__crawler_queueUrls", async (url) => {
    mediaResults.push(await crawler.directFetchCapture(url));
  });

  let waitForVideo = false;

  await page.exposeFunction("__crawler_autoplayLoad", (url) => {
    console.log("*** Loading autoplay URL: " + url);
    waitForVideo = true;
  });

  try {
    await page.evaluateOnNewDocument(autoplayScript);
    await page.evaluateOnNewDocument(autofetchScript);
  } catch(e) {
    console.log(e);
  }

  const gotoOpts = {
    waitUntil: crawler.params.waitUntil,
    timeout: crawler.params.timeout
  };

  try {
    await page.goto(url, gotoOpts);
  } catch (e) {
    console.log(`Load timeout for ${url}`, e);
  }

  try {
    await Promise.all(mediaResults);
  } catch (e) {
    console.log("Error loading media URLs", e);
  }

  if (waitForVideo) {
    console.log("Extra wait 15s for video loading");
    await crawler.sleep(15000);
  }

  if (crawler.params.scroll) {
    try {
      await Promise.race([page.evaluate(autoScroll), crawler.sleep(30000)]);
    } catch (e) {
      console.warn("Behavior Failed", e);
    }
  }

  await crawler.extractLinks(page, "a[href]");
};

async function autoScroll() {
  const canScrollMore = () =>
    self.scrollY + self.innerHeight <
    Math.max(
      self.document.body.scrollHeight,
      self.document.body.offsetHeight,
      self.document.documentElement.clientHeight,
      self.document.documentElement.scrollHeight,
      self.document.documentElement.offsetHeight
    );

  const scrollOpts = { top: 250, left: 0, behavior: "auto" };

  while (canScrollMore()) {
    self.scrollBy(scrollOpts);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}


