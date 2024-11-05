export default async ({ data, page, crawler }) => {
  await crawler.loadPage(page, data);

  await page.pdf({"path": `${crawler.collDir}/${data.pageid}.pdf`});
};
