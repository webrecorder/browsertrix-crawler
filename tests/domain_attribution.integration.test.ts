import child_process from "child_process";
import fs from "fs";

const COLLECTION = "domain-attribution-foreign";
const DOMAIN_STATS_PATH = `test-crawls/collections/${COLLECTION}/reports/domainStats.json`;
const LIMIT_COLLECTION = "domain-attribution-limit";
const LIMIT_DOMAIN_STATS_PATH = `test-crawls/collections/${LIMIT_COLLECTION}/reports/domainStats.json`;
const LIMIT_SKIPPED_PAGES_PATH = `test-crawls/collections/${LIMIT_COLLECTION}/reports/skippedPages.jsonl`;
const BYTE_LIMIT_COLLECTION = "domain-attribution-byte-limit";
const BYTE_LIMIT_DOMAIN_STATS_PATH = `test-crawls/collections/${BYTE_LIMIT_COLLECTION}/reports/domainStats.json`;

test("domain scope attributes embedded foreign resources to the originating seed domain", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType domain --writeDomainStats --collection ${COLLECTION} --limit 1 --behaviors "" --exclude community`,
  );

  expect(fs.existsSync(DOMAIN_STATS_PATH)).toBe(true);

  const stats = JSON.parse(fs.readFileSync(DOMAIN_STATS_PATH, "utf8")) as Array<{
    domain: string;
    bytes: number;
    objects: number;
    limitReached: boolean;
  }>;

  expect(stats.length).toBe(1);
  expect(stats[0].domain).toBe("webrecorder.net");
  expect(stats[0].bytes).toBeGreaterThan(0);
  expect(stats[0].objects).toBeGreaterThan(0);
  expect(stats[0].limitReached).toBe(false);
});

test("domain scope marks the originating seed domain as limitReached once attributed resources hit the per-domain object limit", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType domain --writeDomainStats --reportSkipped --maxObjectsPerDomain 1 --collection ${LIMIT_COLLECTION} --limit 5 --behaviors "" --exclude community`,
  );

  expect(fs.existsSync(LIMIT_DOMAIN_STATS_PATH)).toBe(true);

  const stats = JSON.parse(
    fs.readFileSync(LIMIT_DOMAIN_STATS_PATH, "utf8"),
  ) as Array<{
    domain: string;
    bytes: number;
    objects: number;
    limitReached: boolean;
  }>;

  expect(stats.length).toBe(1);
  expect(stats[0].domain).toBe("webrecorder.net");
  expect(stats[0].objects).toBeGreaterThanOrEqual(1);
  expect(stats[0].limitReached).toBe(true);

  expect(fs.existsSync(LIMIT_SKIPPED_PAGES_PATH)).toBe(true);

  const skippedPages = fs
    .readFileSync(LIMIT_SKIPPED_PAGES_PATH, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => !entry.format);

  expect(skippedPages.some((entry) => entry.reason === "domainLimit")).toBe(
    true,
  );
});

test("domain scope marks the originating seed domain as limitReached once attributed foreign resources hit the per-domain byte limit", () => {
  child_process.execSync(
    `docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --scopeType domain --writeDomainStats --maxBytesPerDomain 1 --collection ${BYTE_LIMIT_COLLECTION} --limit 1 --behaviors "" --exclude community`,
  );

  expect(fs.existsSync(BYTE_LIMIT_DOMAIN_STATS_PATH)).toBe(true);

  const stats = JSON.parse(
    fs.readFileSync(BYTE_LIMIT_DOMAIN_STATS_PATH, "utf8"),
  ) as Array<{
    domain: string;
    bytes: number;
    objects: number;
    limitReached: boolean;
  }>;

  expect(stats.length).toBe(1);
  expect(stats[0].domain).toBe("webrecorder.net");
  expect(stats[0].bytes).toBeGreaterThan(0);
  expect(stats[0].limitReached).toBe(true);
});
