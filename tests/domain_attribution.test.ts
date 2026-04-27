import { jest } from "@jest/globals";
import { Crawler } from "../src/crawler";

function mockDomainCompletenessState(
  initialEntries: Array<[string, "complete" | "incomplete" | "unknown"]> = [],
) {
  const completenessByDomain = new Map(initialEntries);

  return {
    completenessByDomain,
    crawlState: {
      getDomainCompletenessMap: jest.fn(async () =>
        Object.fromEntries(completenessByDomain),
      ),
      getDomainCompleteness: jest.fn(
        async (domain: string) => completenessByDomain.get(domain) || null,
      ),
      setDomainCompleteness: jest.fn(
        async (
          domain: string,
          completeness: "complete" | "incomplete" | "unknown",
        ) => {
          completenessByDomain.set(domain, completeness);
        },
      ),
    },
  };
}

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

  test("adds completeness states to domain stats only for the opt-in depth-0 domain-scope mode", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState([
      ["large.example", "incomplete"],
      ["unclear.example", "unknown"],
      ["small.example", "complete"],
    ]);

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;

    expect(
      await crawler.addDomainCompletenessToStats([
        {
          domain: "large.example",
          bytes: 10,
          objects: 1,
          limitReached: false,
        },
        {
          domain: "small.example",
          bytes: 5,
          objects: 1,
          limitReached: false,
        },
        {
          domain: "unclear.example",
          bytes: 0,
          objects: 0,
          limitReached: false,
        },
      ]),
    ).toEqual([
      {
        domain: "large.example",
        bytes: 10,
        objects: 1,
        limitReached: false,
        completeness: "incomplete",
      },
      {
        domain: "small.example",
        bytes: 5,
        objects: 1,
        limitReached: false,
        completeness: "complete",
      },
      {
        domain: "unclear.example",
        bytes: 0,
        objects: 0,
        limitReached: false,
        completeness: "unknown",
      },
    ]);
  });

  test("probes additional depth-1 candidates without queueing them", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState();

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");
    crawler.getScope = jest
      .fn()
      .mockReturnValueOnce({
        url: "https://seed.example/about",
        isOOS: false,
      })
      .mockReturnValueOnce(false);
    crawler.runLinkExtraction = jest.fn(async (_frames, _selectors, _logDetails) => {
      await data.callbacks.addLink("https://seed.example/about");
      await data.callbacks.addLink("https://offscope.example/");
      return { hadErrors: false };
    });

    const data: any = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    };

    await crawler.probeDomainStatsCompleteness(
      {} as any,
      data,
      [],
      {},
    );

    expect(crawler.getScope).toHaveBeenNthCalledWith(
      1,
      {
        url: "https://seed.example/about",
        extraHops: 0,
        depth: 0,
        seedId: 0,
        noOOS: false,
      },
      {},
    );
    expect(await crawler.getDomainCompleteness("seed.example")).toBe(
      "incomplete",
    );
  });

  test("marks completeness as unknown when the probe encounters link extraction errors", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState();

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");
    crawler.runLinkExtraction = jest.fn(async () => ({ hadErrors: true }));

    const data: any = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    };

    await crawler.probeDomainStatsCompleteness(
      {} as any,
      data,
      [],
      {},
    );

    expect(await crawler.getDomainCompleteness("seed.example")).toBe("unknown");
  });

  test("does not downgrade complete completeness to unknown for a failed sibling seed", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState([["seed.example", "complete"]]);

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");

    await crawler.markDomainCompletenessUnknownForPage({
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
    });

    expect(await crawler.getDomainCompleteness("seed.example")).toBe("complete");
  });

  test("skips retries for failed sibling seeds once completeness is already known", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState([
      ["seed.example", "incomplete"],
    ]);

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");

    expect(
      await crawler.shouldSkipRetriesForDomainCompleteness({
        url: "https://www.seed.example/",
        seedId: 1,
        depth: 0,
      }),
    ).toBe(true);
  });

  test("promotes unknown to complete when a later probe succeeds cleanly", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState([["seed.example", "unknown"]]);

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");
    crawler.runLinkExtraction = jest.fn(async () => ({ hadErrors: false }));

    const data: any = {
      url: "http://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    };

    await crawler.probeDomainStatsCompleteness(
      {} as any,
      data,
      [],
      {},
    );

    expect(await crawler.getDomainCompleteness("seed.example")).toBe("complete");
  });

  test("detects theoretical next-hop in-scope links even when depth is 0", async () => {
    const crawler = Object.create(Crawler.prototype) as any;
    const { crawlState } = mockDomainCompletenessState();

    crawler.params = {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    };
    crawler.crawlState = crawlState;
    crawler.getAttributedDomain = jest.fn().mockReturnValue("seed.example");
    crawler.getScope = jest.fn().mockReturnValue({
      url: "https://seed.example/about",
      isOOS: false,
    });
    crawler.runLinkExtraction = jest.fn(async (_frames, _selectors, _logDetails) => {
      await data.callbacks.addLink("https://seed.example/#top");
      await data.callbacks.addLink("https://seed.example/about");
      return { hadErrors: false };
    });

    const data: any = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    };

    await crawler.probeDomainStatsCompleteness(
      {
        url: () => "https://seed.example/",
      } as any,
      data,
      [],
      {},
    );

    expect(crawler.getScope).toHaveBeenCalledWith(
      {
        url: "https://seed.example/about",
        extraHops: 0,
        depth: 0,
        seedId: 0,
        noOOS: false,
      },
      {},
    );
    expect(await crawler.getDomainCompleteness("seed.example")).toBe(
      "incomplete",
    );
  });
});
