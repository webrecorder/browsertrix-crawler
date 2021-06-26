
module.exports = async ({data, page, crawler}) => {
  await crawler.loadPage(page, data);
};
