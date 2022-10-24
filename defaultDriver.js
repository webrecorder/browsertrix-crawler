
export default async ({data, page, crawler}) => {
  await crawler.loadPage(page, data);
};
