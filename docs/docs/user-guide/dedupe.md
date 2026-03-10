# Deduplication

With version 1.12, the crawler includes full support for deduplication ("dedupe") of crawled content by content hash,
avoiding saving the same content multuple times. When a duplicate is encountered, the crawler saves a reference to the original content, instead of the full response. The crawler supports deduplication in several ways.

## Automatic deduplication within a single crawl

By default, the crawler applies the following deduplication automatically:

- URL-based deduplication: If the same URL is encountered multiple times in a single crawl, the URL is automatically skipped, no revisit record is written.
- Content-based deduplication: If a URL that points to the same *content*, but at a different URL is encountered, a `revisit` record is written,
pointing to the first URL that has the same content. This allows for deduplication of the same content even across different URLs.

## Deduplication across multiple crawls

The crawler also supports content-based deduplication by content across multiple crawls, with an external Redis (or Redis-compatible database) index used to store the deduplication data.

To enable, add `--redisDedupeUrl <redis url>` with a standard Redis format URL `redis://host:port/db`, e.g. `--redisDedupeUrl redis://my-dedupe-index:6379/0`.

Unlike the internal Redis index which is designed for the lifetime of a single crawl, this index is expected to persist accross crawls and is expected to hold all the unique hashes across many crawls.

When enabled, the external index will store the hashes of HTTP content that has previously been archived. For each URL crawled, it'll store the unique hash and first URL and timestamp of that URL in the index. If the hash has already
been archived, it will not be saved again, instead a [`revisit` record will be created](#warc) instead.

!!! tip "Using Kvrocks instead of Redis"
  
    While the index needs to be Redis-compatible, any Redis-compatible database can be used as well without additional changes. [Apache Kvrocks](https://kvrocks.apache.org/) is a good choice for the dedupe index database as it persists the data on disk, instead of keeping it all in memory like Redis. 

When multiple crawls are running at the same time, the resources from one crawl are not yet available to the other crawls.
This is to account for crawls that may be cancelled or fail.

Once a crawl is complete, its data is fully committed to the index and available to be deduplicated against by future crawls.

### Example: Running crawls with deduplication

Here's a quick example of running crawls with dedupe against the same index:

1) Start Redis server, e.g. `redis-server -p 10000`

2) Run a crawl with `--redisDedupeUrl` set, e.g. a crawl of 5 pages from `https://old.webrecorder.net/`:

```sh
docker run -it webrecorder/browsertrix-crawler crawl --redisDedupeUrl redis://localhost:10000/0 --url https://old.webrecorder.net/ --generateWACZ --collection firstCrawl --limit 5
```

3) Run a second crawl with same settings:

```sh
docker run -it webrecorder/browsertrix-crawler crawl --redisDedupeUrl redis://localhost:10000/0 --url https://old.webrecorder.net/ --generateWACZ --collection secondCrawl --limit 5
```

The second crawl should be significantly smaller than the first, as duplicate content is not written. Instead, much smaller [`revisit` records](#warc) are added for each URL that was already crawled in the first crawl.


## Create deduplication index from existing crawls

It may sometimes be useful to populate the dedupe index with existing data, e.g. one or more WACZ files of previous crawls. This can be done by reading through all the entries in the CDXJ index inside of a WACZ and populating the dedupe index based on this data.


The crawler also includes a new dedicated entrypoint, `indexer`, to support this operation.

For example, given an existing WACZ file `my-crawl.wacz`:

1) Run the indexer import:

```sh
docker run -it webrecorder/browsertrix-crawler index --sourceUrl my-crawl.wacz --redisDedupeUrl redis://localhost:10000/0 
```

This will populate the dedupe index with all the content of `my-crawl.wacz`.

2) It is now possible to run crawls against the deduplication index, e.g.:

```sh
docker run -it webrecorder/browsertrix-crawler crawl --redisDedupeUrl redis://localhost:10000/0 ...
```

### Removing data from deduplication index

By default, the `indexer` operation is additive only, meaning that crawl data is added, but not removed.
To remove all crawls that aren't part of `--sourceUrl` (either single WACZ or a JSON specifying multiple WACZs),
also add the `--remove` flag. This will purge all data that is not being added.

For a complete list of indexer CLI flags, see [indexer CLI flags](cli-options/#indexer).


## Deduplication architecture
See the [developer docs for dedupe](../develop/dedupe.md) for more advanced information of the architecture of the dedupe system.


## Deduplication outputs

When deduplication is enabled, the crawler output is changed in the following ways (in addition to using
less disk storage overall):

### WARC

The crawler will write WARC `revisit` records to indicate
that a particular HTTP response has already been crawled. These records include a reference to the URL and timestamp
of the original WARC `response` record, which includes the full content.

HTTP headers are not deduplicated and are included in the `revisit` records.

### WACZ

When using deduplication, the crawler also stores dependency information between WACZ files, tracking which WACZ
file(s) contain the WARCs with `response` records for each `revisit` record that is written.
This allows for tracking which WACZ files are required by other WACZ files to get the full archived content.
See the [WACZ dependency section of the developer documentation](../develop/dedupe.md#crawl-dependency-tracking-in-wacz-datapackagejson) for more details on the architecture of this dependency system.