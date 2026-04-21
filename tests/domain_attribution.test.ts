import { jest } from "@jest/globals";
import { Crawler } from "../src/crawler";

describe("domain attribution", () => {
  test("attributes non-seed domains to the originating seed and preserves original seed domains", () => {
    const crawler = Object.create(Crawler.prototype) as Crawler;

    crawler.originalSeedDomains = new Set(["test.at", "foo.bar"]);
    crawler.seedAttributedDomains = new Map([
      [0, "test.at"],
      [1, "foo.bar"],
    ]);

    expect(crawler.getAttributedDomain("https://cdn.example.org/app.js", 0)).toBe(
      "test.at",
    );

    expect(crawler.getAttributedDomain("https://www.foo.bar/page", 0)).toBe(
      "foo.bar",
    );

    crawler.registerAttributedDomainForRedirectSeed(2, 0);

    expect(
      crawler.getAttributedDomain("https://redirect-target.example.org/", 2),
    ).toBe("test.at");
  });

  test("keeps the originating seedId when discovered links are queued", async () => {
    const crawler = Object.create(Crawler.prototype) as any;

    const getScope = jest
      .fn()
      .mockReturnValueOnce({
        url: "https://cdn.example.org/embed",
        isOOS: false,
      })
      .mockReturnValueOnce({
        url: "https://www.foo.bar/page",
        isOOS: true,
      });
    const queueUrl = jest.fn(async () => true);
    const writeSkippedPage = jest.fn();

    crawler.getScope = getScope;
    crawler.queueUrl = queueUrl;
    crawler.writeSkippedPage = writeSkippedPage;

    await crawler.queueInScopeUrls(
      7,
      ["https://cdn.example.org/embed", "https://www.foo.bar/page"],
      2,
      1,
    );

    expect(queueUrl).toHaveBeenNthCalledWith(
      1,
      7,
      "https://cdn.example.org/embed",
      3,
      1,
      {},
    );
    expect(queueUrl).toHaveBeenNthCalledWith(
      2,
      7,
      "https://www.foo.bar/page",
      3,
      2,
      {},
    );
    expect(writeSkippedPage).not.toHaveBeenCalled();
  });
});
