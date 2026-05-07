import { jest } from "@jest/globals";
import { Crawler } from "../src/crawler";
import { InterruptReason, SkippedReason } from "../src/util/constants";
import { PageState } from "../src/util/state";

type DomainCompleteness = "complete" | "incomplete" | "unknown";
type MockDomainCrawlState = ReturnType<
  typeof mockDomainCompletenessState
>["crawlState"];
type ProbePage = Parameters<Crawler["probeDomainStatsCompleteness"]>[0];
type ProbeData = Parameters<Crawler["probeDomainStatsCompleteness"]>[1];
type ProbeSelectors = Parameters<Crawler["probeDomainStatsCompleteness"]>[2];
type ProbeLogDetails = Parameters<Crawler["probeDomainStatsCompleteness"]>[3];
type GetScopeFn = (
  args: {
    seedId: number;
    url: string;
    depth: number;
    extraHops: number;
    noOOS: boolean;
    pageUrl?: string;
  },
  logDetails?: object,
) => false | { url: string; isOOS: boolean };
type QueueUrlFn = (
  seedId: number,
  url: string,
  depth: number,
  extraHops: number,
  logDetails?: ProbeLogDetails,
  ts?: number,
  pageid?: string,
) => Promise<boolean>;
type WriteSkippedPageFn = (
  url: string,
  seedId: number,
  depth: number,
  reason: SkippedReason,
) => void;
type RunLinkExtractionFn = (
  frames: ProbeData["filteredFrames"],
  selectors: ProbeSelectors,
  logDetails: ProbeLogDetails,
) => Promise<{ hadErrors: boolean }>;
type GetAttributedDomainFn = (url: string, seedId: number) => string | null;
type DomainStatsParams = {
  domainStatsCompleteness: boolean;
  scopeType: string;
  depth: number;
};
type ExtendedMockDomainCrawlState = MockDomainCrawlState & {
  serialize?: jest.Mock;
  isCrawlStopped?: jest.Mock;
};

function mockDomainCompletenessState(
  initialEntries: Array<[string, DomainCompleteness]> = [],
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
        async (domain: string, completeness: DomainCompleteness) => {
          completenessByDomain.set(domain, completeness);
        },
      ),
    },
  };
}

describe("domain attribution", () => {
  const createCrawler = () => Object.create(Crawler.prototype) as Crawler;
  const setParams = (crawler: Crawler, params: DomainStatsParams) => {
    (crawler as unknown as { params: Crawler["params"] }).params =
      params as unknown as Crawler["params"];
  };
  const setCrawlState = (
    crawler: Crawler,
    crawlState: ExtendedMockDomainCrawlState,
  ) => {
    (crawler as unknown as { crawlState: Crawler["crawlState"] }).crawlState =
      crawlState as unknown as Crawler["crawlState"];
  };
  const setGetScope = (
    crawler: Crawler,
    getScope: jest.MockedFunction<GetScopeFn>,
  ) => {
    (crawler as unknown as { getScope: GetScopeFn }).getScope = getScope;
  };
  const setQueueUrl = (
    crawler: Crawler,
    queueUrl: jest.MockedFunction<QueueUrlFn>,
  ) => {
    (crawler as unknown as { queueUrl: QueueUrlFn }).queueUrl = queueUrl;
  };
  const setWriteSkippedPage = (
    crawler: Crawler,
    writeSkippedPage: jest.MockedFunction<WriteSkippedPageFn>,
  ) => {
    (
      crawler as unknown as { writeSkippedPage: WriteSkippedPageFn }
    ).writeSkippedPage = writeSkippedPage;
  };
  const setGetAttributedDomain = (
    crawler: Crawler,
    getAttributedDomain: jest.MockedFunction<GetAttributedDomainFn>,
  ) => {
    (
      crawler as unknown as { getAttributedDomain: GetAttributedDomainFn }
    ).getAttributedDomain = getAttributedDomain;
  };
  const mockGetAttributedDomain = () => jest.fn<GetAttributedDomainFn>();
  const setRunLinkExtraction = (
    crawler: Crawler,
    runLinkExtraction: jest.MockedFunction<RunLinkExtractionFn>,
  ) => {
    (
      crawler as unknown as { runLinkExtraction: RunLinkExtractionFn }
    ).runLinkExtraction = runLinkExtraction;
  };

  test("attributes non-seed domains to the originating seed and preserves original seed domains", () => {
    const crawler = Object.create(Crawler.prototype) as Crawler;

    crawler.originalSeedDomains = new Set(["test.at", "foo.bar"]);
    crawler.seedAttributedDomains = new Map([
      [0, "test.at"],
      [1, "foo.bar"],
    ]);

    expect(
      crawler.getAttributedDomain("https://cdn.example.org/app.js", 0),
    ).toBe("test.at");

    expect(crawler.getAttributedDomain("https://www.foo.bar/page", 0)).toBe(
      "foo.bar",
    );

    crawler.registerAttributedDomainForRedirectSeed(2, 0);

    expect(
      crawler.getAttributedDomain("https://redirect-target.example.org/", 2),
    ).toBe("test.at");
  });

  test("keeps the originating seedId when discovered links are queued", async () => {
    const crawler = createCrawler();

    const getScope = jest
      .fn()
      .mockReturnValueOnce({
        url: "https://cdn.example.org/embed",
        isOOS: false,
      })
      .mockReturnValueOnce({
        url: "https://www.foo.bar/page",
        isOOS: true,
      }) as jest.MockedFunction<GetScopeFn>;
    const queueUrl = jest.fn(
      async () => true,
    ) as jest.MockedFunction<QueueUrlFn>;
    const writeSkippedPage =
      jest.fn() as jest.MockedFunction<WriteSkippedPageFn>;

    setGetScope(crawler, getScope);
    setQueueUrl(crawler, queueUrl);
    setWriteSkippedPage(crawler, writeSkippedPage);

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
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState([
      ["large.example", "incomplete"],
      ["unclear.example", "unknown"],
      ["small.example", "complete"],
    ]);

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);

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
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();
    const data = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    const getScope = jest
      .fn()
      .mockReturnValueOnce({
        url: "https://seed.example/about",
        isOOS: false,
      })
      .mockReturnValueOnce(false) as jest.MockedFunction<GetScopeFn>;
    setGetScope(crawler, getScope);
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => {
        await data.callbacks.addLink?.("https://seed.example/about");
        await data.callbacks.addLink?.("https://offscope.example/");
        return { hadErrors: false };
      }) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    await crawler.probeDomainStatsCompleteness(
      {} as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
    );

    expect(getScope).toHaveBeenNthCalledWith(
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
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => ({
        hadErrors: true,
      })) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    const data = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    await crawler.probeDomainStatsCompleteness(
      {} as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
    );

    expect(await crawler.getDomainCompleteness("seed.example")).toBe("unknown");
  });

  test("does not downgrade complete completeness to unknown for a failed sibling seed", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState([
      ["seed.example", "complete"],
    ]);

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );

    await crawler.markDomainCompletenessUnknownForPage({
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
    } as unknown as PageState);

    expect(await crawler.getDomainCompleteness("seed.example")).toBe(
      "complete",
    );
  });

  test("skips retries for failed sibling seeds once completeness is already known", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState([
      ["seed.example", "incomplete"],
    ]);

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );

    expect(
      await crawler.shouldSkipRetriesForDomainCompleteness({
        url: "https://www.seed.example/",
        seedId: 1,
        depth: 0,
      } as unknown as PageState),
    ).toBe(true);
  });

  test("promotes unknown to complete when a later probe succeeds cleanly", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState([
      ["seed.example", "unknown"],
    ]);
    const data = {
      url: "http://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => ({
        hadErrors: false,
      })) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    await crawler.probeDomainStatsCompleteness(
      {} as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
    );

    expect(await crawler.getDomainCompleteness("seed.example")).toBe(
      "complete",
    );
  });

  test("detects theoretical next-hop in-scope links even when depth is 0", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();
    const data = {
      url: "https://seed.example/",
      seedId: 0,
      depth: 0,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 0,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    const getScope = jest.fn().mockReturnValue({
      url: "https://seed.example/about",
      isOOS: false,
    }) as jest.MockedFunction<GetScopeFn>;
    setGetScope(crawler, getScope);
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => {
        await data.callbacks.addLink?.("https://seed.example/#top");
        await data.callbacks.addLink?.("https://seed.example/about");
        return { hadErrors: false };
      }) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    await crawler.probeDomainStatsCompleteness(
      {
        url: () => "https://seed.example/",
      } as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
    );

    expect(getScope).toHaveBeenCalledWith(
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

  test("marks deep crawl completeness incomplete when a max-depth page exposes more in-scope links", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();
    const data = {
      url: "https://seed.example/1.html",
      seedId: 0,
      depth: 1,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 1,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    const getScope = jest.fn().mockReturnValue({
      url: "https://seed.example/2.html",
      isOOS: false,
    }) as jest.MockedFunction<GetScopeFn>;
    setGetScope(crawler, getScope);
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => {
        await data.callbacks.addLink?.("https://seed.example/2.html");
        return { hadErrors: false };
      }) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    await crawler.probeDomainStatsCompleteness(
      {
        url: () => "https://seed.example/1.html",
      } as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
      true,
    );

    expect(getScope).toHaveBeenCalledWith(
      {
        url: "https://seed.example/2.html",
        extraHops: 0,
        depth: 1,
        seedId: 0,
        noOOS: false,
      },
      {},
    );
    expect(await crawler.getDomainCompleteness("seed.example")).toBe(
      "incomplete",
    );
  });

  test("finalizes deep crawl completeness from remaining work and failed URLs", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 5,
    });
    setCrawlState(crawler, {
      ...crawlState,
      serialize: jest.fn(async () => ({
        queued: [
          JSON.stringify({
            url: "https://stopped.example/about",
            seedId: 1,
            depth: 2,
            extraHops: 0,
          }),
        ],
        pending: [],
        failed: [
          JSON.stringify({
            url: "https://failed.example/contact",
            seedId: 2,
            depth: 2,
            extraHops: 0,
          }),
        ],
      })),
      isCrawlStopped: jest.fn(async () => true),
    });
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockImplementation(
        (_url: string, seedId: number) => {
          switch (seedId) {
            case 0:
              return "complete.example";
            case 1:
              return "stopped.example";
            case 2:
              return "failed.example";
            default:
              return null;
          }
        },
      ),
    );

    expect(
      await crawler.addDomainCompletenessToStats(
        [
          {
            domain: "complete.example",
            bytes: 10,
            objects: 1,
            limitReached: false,
          },
          {
            domain: "stopped.example",
            bytes: 20,
            objects: 2,
            limitReached: false,
          },
          {
            domain: "failed.example",
            bytes: 30,
            objects: 3,
            limitReached: false,
          },
        ],
        true,
      ),
    ).toEqual([
      {
        domain: "complete.example",
        bytes: 10,
        objects: 1,
        limitReached: false,
        completeness: "complete",
      },
      {
        domain: "stopped.example",
        bytes: 20,
        objects: 2,
        limitReached: false,
        completeness: "incomplete",
      },
      {
        domain: "failed.example",
        bytes: 30,
        objects: 3,
        limitReached: false,
        completeness: "unknown",
      },
    ]);
  });

  test("finalizes deep crawl completeness as unknown for unresolved work after browser crash", async () => {
    const crawler = createCrawler();
    const { crawlState } = mockDomainCompletenessState();

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 5,
    });
    crawler.interruptReason = InterruptReason.BrowserCrashed;
    setCrawlState(crawler, {
      ...crawlState,
      serialize: jest.fn(async () => ({
        queued: [],
        pending: [
          JSON.stringify({
            url: "https://unknown.example/home",
            seedId: 0,
            depth: 1,
            extraHops: 0,
          }),
        ],
        failed: [],
      })),
      isCrawlStopped: jest.fn(async () => false),
    });
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("unknown.example"),
    );

    expect(
      await crawler.addDomainCompletenessToStats(
        [
          {
            domain: "unknown.example",
            bytes: 10,
            objects: 1,
            limitReached: false,
          },
        ],
        true,
      ),
    ).toEqual([
      {
        domain: "unknown.example",
        bytes: 10,
        objects: 1,
        limitReached: false,
        completeness: "unknown",
      },
    ]);
  });

  test("does not downgrade incomplete to complete when a later probe finds no out-links", async () => {
    const crawler = createCrawler();
    const { crawlState, completenessByDomain } = mockDomainCompletenessState([
      ["seed.example", "incomplete"],
    ]);
    const data = {
      url: "https://seed.example/leaf.html",
      seedId: 0,
      depth: 1,
      extraHops: 0,
      filteredFrames: [],
      callbacks: {},
    } as unknown as ProbeData;

    setParams(crawler, {
      domainStatsCompleteness: true,
      scopeType: "domain",
      depth: 1,
    });
    setCrawlState(crawler, crawlState);
    setGetAttributedDomain(
      crawler,
      mockGetAttributedDomain().mockReturnValue("seed.example"),
    );
    setRunLinkExtraction(
      crawler,
      jest.fn(async () => ({
        hadErrors: false,
      })) as jest.MockedFunction<RunLinkExtractionFn>,
    );

    await crawler.probeDomainStatsCompleteness(
      { url: () => "https://seed.example/leaf.html" } as ProbePage,
      data,
      [] as ProbeSelectors,
      {} as ProbeLogDetails,
      true,
    );

    expect(completenessByDomain.get("seed.example")).toBe("incomplete");
  });
});
