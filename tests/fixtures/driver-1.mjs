export default async ({ data, page, crawler }) => {
  await crawler.loadPage(page, data, [
    { selector: "script[src]", extract: "src", isAttribute: false },
  ]);
};
