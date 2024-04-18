# Quality Assurance

## Overview

Browsertrix Crawler has the capability to "re-crawl" an existing crawl to compare what the browser encountered on a website during crawling against the replay of the crawl WACZ. The WACZ produced by this analysis run includes additional comparison data (stored as WARC `resource` records) for the pages found during crawling against their replay in ReplayWeb.page along several dimensions, including screenshot, text comparisons and resource compar

QA features described on this page are available in Browsertrix Crawler releases 1.1.0 and later.

## Getting started

To analyze an existing crawl, call Browsertrix Crawler with the `qa` entrypoint, passing the original crawl WACZ as the `qaSource`:

```sh
docker run -v $PWD/crawls/:/crawls/ -it webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/example-crawl/example-crawl.wacz --collection example-qa --generateWACZ
```

The `qaSource` can be:
- a local WACZ file path or a URL
- a single WACZ or a json file containing a list of WACZ files in the `resources` json (Multi-WACZ)

This assumes an existing crawl that was created in the `example-crawl` collection.

This will result in a new WACZ for the analysis run in the resulting `example-qa` collection.

By default, the QA crawl will visit all of the pages (as read from the source WACZ file(s)), however pages can further be limited by adding `--include` and `--exclude` regexes. The `--limit` flag will also limit how pages are tested.

The QA crawl will skip over any non-HTML pages.

## Comparison Dimensions

### Screenshot Match

Assuming that the original crawl was produced with the `--screenshot view` option, the initial viewport screenshots of each page from the crawl and replay are compared on the basis of matching pixel count. This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay screenshots for each page. The screenshots are stored in `urn:view:<url>` WARC resource records.

### Text Match

Assuming that the original crawl was produced with the `--text to-warc` option, extracted text of each page from the crawl and replay are compared on the basis of [Levenshtein distance](https://en.wikipedia.org/wiki/Levenshtein_distance). This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay text for each page. The extracted text is stored in `urn:text:<url>` WARC resource records

### Resources and Page Info

The `pageinfo` records produced by the crawl and analysis runs contain a JSON document containing information about the resources loaded on each page, such as CSS stylesheets, JavaScript scripts, fonts, images, and videos.

In addition to the status code, MIME type, and resource type for each resource, the `pageinfo` records produced by the analysis run additionally include overall resource counts. These counts are divided between "good" (2xx or 3xx status code) and "bad" (4xx or 5xx status code), as well as crawl and replay.

Since `pageinfo` records are produced for all crawls, this data is always available.

### Comparison Data

The comparison data is also added to the QA crawl's pageinfo records. The comparison data may look as follows:

```json

"comparison": {
  "screenshotMatch": 0.95
  "textMatch": 0.9
  "resourceCounts": {
    "crawlGood": 10
    "crawlBad": 0
    "replayGood": 9
    "replayBad": 1
  }
}
```

This data indicates that:
- when comparing `urn:view:<url>` records for crawl and replay, the screenshots are 95% similar,
- when comparing `urn:text:<url>` records from crawl and replay WACZs, the text is 90% similar,
- when comparing `urn:pageinfo:<url>` resource entries from crawl and replay, the crawl record
had 10 good responses (2xx/3xx) and 0 bad responses (4xx/5xx), while replay had 9 good and 1 bad.
