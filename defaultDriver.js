
module.exports = async ({data, page, crawler}) => {
  const {url} = data;
  await crawler.loadPage(page, url);
};
