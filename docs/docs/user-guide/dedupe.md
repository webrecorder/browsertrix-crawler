## Deduplication

With version 1.12, the crawler includes full support for deduplication of crawled content by content hash,
avoiding saving the same content multuple times. When a duplicate is encountered, the crawler saves a reference to the original content, instead of the full response. The crawler supports deduplication in several ways.

### Automatic Deduplication within a singe crawl

By default, the crawler applies the following deduplication automatically:

- If the same URL is encountered multiple times in a single crawl, the URL is automatically skipped, no revisit record is written.
- If a URL that points to the same *content*, but at a different URL is encountered, a `revisit` record is written,
pointing to the first URL that has the same content. This allows for deduplication of the same content even across different URLs.

### URL Deduplication across multiple crawls

The crawler also supports deduplication across multiple crawls, with an external Redis based index which stores
the dedupe data.

To enable this deduplication, add `--redisDedupeUrl <redis url>`, eg. with a standard Redis format URL: `redis://host:port/db`, eg. `--redisDedupeUrl redis://my-dedupe-index:6379/0`

Unlike the internal Redis index which is designed for the lifetime of a single crawl, this index is expected to persist accross crawls and is expected to hold all the unique hashes across many crawls.

While the index needs to be Redis-compatible, other Redis alternatives can be used as well without additional changes.
In particularly, Apache Kvrocks is a good option as it persists the index data on disk, using more disk space
but less RAM then Redis for larger datasets.

When multiple crawls are running at the same time, the resources from one crawl are not yet available to the other crawls.
This is to allow crawls that may be cancelled or may fail.
Once a crawl is complete, it's data is fully 'committed' to the index and available to be deduplicated against by future crawls.

### Dedupe Architecture
See the [developer docs for dedupe](../develop/dedupe.md) for more advanced information of the architecture of the dedupe system.


### How Dedupe affects crawl output

When using deduplication, the crawler output is changed in the following ways:

#### WARC

The crawler will write WARC `revisit` records to indicate
that a particular HTTP response has already been crawled. These records include a reference to URL and timestamp
of the original WARC `response` record, which includes the full content.

HTTP headers are not deduplicated and are included in the `revisit` records.

#### WACZ

When using deduplication, the crawler also stores dependency information between WACZ files, tracking which WACZ
file(s) contain the WARCs with `response` records for each `revisit` record that is written.
This allows for tracking which WACZ files are required by other WACZ files to get the full archived content.
See [WACZ dependency docs](../develop/dedupe.md#crawl-dependency-tracking-in-wacz-datapackagejson) for more details on the architecture
of this dependency system.
