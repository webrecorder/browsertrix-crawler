# Deduplication Architecture


## Hash-Based Dedupe

Browsertrix supports deduplication by identical URL hash, allowing
for WARC revisit records to be written when additional content is archived with a hash that
has already been seen.

To allow deduplication across many crawls, a separate Redis instance is used to store the dedupe
data, though for a single crawl, it can also be the same Redis as the crawl redis.

The following Redis keys are used while a crawl is running:

### Crawl Dedupe Keys

`h:${crawlid}`: `{[hash]`: `[dedupe data]}` - A Redis hash map for each unique hash crawled
- `[hash]`: The hash, with prefix, same as `WARC-Payload-Digest`
- `[dedupe data]`: A space delimited string consisting of `${waczIndex} ${date} ${url} ${size}` for the original response record URL that
the hash represents. The `date` and `url` are used to `WARC-Refers-To-Target-URI` and `WARC-Refers-To-Date` fields.
The `size` is used to determine size conserved. The `waczIndex` in `h:${crawlid}` respresents which exact WACZ this response will be stored in, defaults to `0` if no WACZ will be created/only one WACZ.

`c:${crawlid}:wacz`: `[{filename, hash, size}]` - A Redis list of all WACZ files per crawl, stored as JSON entry. When crawling, a placeholder `{filename}`  is added to the list, the `waczIndex` in the per-hash data `h:${crawlid}` references this list, to save space. When the WACZ is finished, the `{filename}` is replaced with the full `{filename, hash, size}` for that index, or unchanged if no WACZ is actaully generated.


`h:${crawlid}:counts`: Per Crawl Stats, including the following
- `totalCrawlSize`: size of crawl, incremented with size of each WACZ in `c:${crawlid}:wacz`
- `totalUrls`: total number of `response` and `revisit` records written for the crawl.
- `dupeUrls`: number of `revisit` records written
- `conservedSize`: estimated size saved by using dedupe, computed as the difference: `response record size - revisit record size`

### Crawl Tracking

The dedupe Redis may keep crawl data for multiple running crawls. Since crawls may be canceled and removed
before they are finished, the crawl data is not used as part of the dedupe until the crawls are finished and 'committed'
to the merged index. The following key is used to track uncomitted crawls:

- `uncommittedcrawls`: `[crawl id]` - a Redis Set of `crawlid` that are in progress, eg. `h:${crawlid}`, `h:${crawlid}:wacz`, `c:${crawlid}:counts` key exists and are being updated. The crawl is not yet part of the merged index.

If a crawl is canceled, these 3 keys should be removed and the crawl id should be removed from `uncommittedcrawls`

### Committed Crawls / Merged Index Keys

Once a crawl is finished, the merged index keys are updated as follows:

- `allcrawls`: `[crawl id]` - crawl id is removed from `uncommittedcrawls` Redis set and added to `allcrawls` Redis set. This implies
`allhashes` and `allcounts` has some data from each crawl id in the set.

- `allhashes`: `{[hash]: [crawlid]}` - The main merged index. For each hash in `h:${crawlid}`, an entry is added mapping `hash` to the `crawlid`, indicating the hash is found in this crawl. The full data from `h:${crawlid}` is not copied to save space.

- `allcounts`: A sum of all the `h:${crawlid}:counts` for all crawlids in `allcrawls`. The `allcounts` fields are incremented by each new `h:${crawlid}:counts`

#### Dedupe Lookup

To write a revisit record, two Redis lookups are needed:
`allhashes[hash] -> crawlid`
`h:${crawlid}[hash] -> waczIndex date url size`

### Index Importing

The crawler supports the ability to populate an index from an existing set of WACZ files, via the `indexer` entrypoint.

The indexer can be run via `webrecorder/browsertrix-crawler indexer --sourceUrl <source WACZ or JSON> [--remove]`

The `<source WACZ or JSON>` can either be a single WACZ, or, more likely, a JSON (roughtly conformin to MultiWACZ spec) manifest containing a list of WACZ files that should be processed to populate the dedupe index.
The WACZ files are listed in the `resources` list in the manifest as follows:

json
```
{
  "resources": [{
    "name": <unique wacz name>
    "path": <URL of WACZ>
    "hash": <hash of WACZ>
    "size": <size of WACZ>
    "crawlId": <crawl id>
}]}
```

The indexer process will then read the CDX from each WACZ and populate the dedupe index keys listed above, both per crawl and merged keys listed above, based on this data.

#### Import Tracking

A number of additional keys are used to faciliating the indexing.
The list of WACZ files from resources are queued to the `src:q` list.
The `src:qset` is used to store the unique WACZ `name`, to avoid queuing the same files
(but at different paths) multiple times. The `src:d` set stores the set of finished WACZ files.
(While processing, each WACZ is added to the `pending:q` and a temp key is used to avoid retrying
pending files)

The `updateProgress` tracks the percentage of files finished, while `last_update_ts` is used to
store a timestamp when indexing is done.

### Removal Tracking

The JSON manifest is assumed to the full list of WACZ files in a collection.

If certain previously imported crawls are removed from the manifes in subsequent runs, the importer
also tracks these. For every import run, if a crawl is already in `allcrawls` but was not found
in the latest import (eg. no WACZ with that `crawlId` was found), the crawl is added to the
`removedCrawls` count and the size of that crawl is tracked in `removedCrawlSize` in `allcounts`.

By default, removed crawls are kept in the index.

### Purging the Index

By using the `--remove` command-line option, crawls not found in the import manifest are instead removed.

This is done by first running an import and keeping track of crawls that have been removed/no longer found in the manifest.
Then, the per-crawl keys (`h:${crawlid}`, `h:${crawlid}:counts`, `c:${crawlid}:wacz`) are deleted for each removed crawl.
The removed crawls are removed from `allcrawls` and the `alldupes`, `allcounts` keys are recreated from scratch from
the existing crawls, by rerunning the crawl 'commit' process for each existing crawl.

The result is that all data related to removed crawls is purged, and the `removeCrawlSize` and `removeCrawls` counts are reset to 0.

## Crawl Dependency Tracking in WACZ datapackage.json

Deduplication adds an inherent dependency system, where a WACZ from one crawl (which contains `revisit` records) is now dependent on a WACZ from another crawl (which contains the original `response` records).
For correct replay, both WACZ files must be present.

The dedupe system also provides the ability to track these dependencies.
The dependencies are tracked in the main per-crawl Redis, not the dedupe Redis, which may be different instances.

When a `revisit` record is written, an entry is all made in the crawler Redis:
1. the `crawlId` of the source crawl is added to `${thisCrawlId}:reqCrawls`
2.  the string `$crawlId $waczIndex` is also added to the set `${uuid}:duperefs`

The first entry allows tracking which crawls this current crawl is dependent on.
The second entry allows for more granular tracking of which exact WACZ files in the other crawls are the dependencies
for this crawl.

The data from the second `${uuid}:duperefs` is used to populate the `relation.requires` entry for the current WACZ file with data from the other crawls `c:${crawlid}:wacz` to list the exact WACZ files and their hashes for the dependencies directly in the `datapackage.json`.

For example, a WACZ file with dependencies on other WACZs from another crawl may look as follows:

```json
{
  "resources": {
    //resources in this WACZ file
  },
  ...
  "relation": {
    "requires": [
      {
        "filename": "<dependency WACZ name>",
        "hash": "<dependency WACZ hash",
        "size": <dependency WACZ size>,
        "crawlId": "<dependency crawl ID>"
      },
      ...
    ]
  }
}
```

If the WACZ files are signed, this helps ensure integrity of crawls with deduplication depenencies on other crawls, since
all data in the `datapackage.json` will also be signed.