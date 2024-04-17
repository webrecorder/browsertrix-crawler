# Quality Assurance

## Overview

Browsertrix Crawler has the capability to "re-crawl" an existing crawl to compare what the browser encountered on a website during crawling against the replay of the crawl WACZ. The WACZ produced by this analysis run includes resource records with comparison data for the pages found during crawling against their replay in ReplayWeb.page along several dimensions, including screenshot and text comparisons.

QA features described on this page are available in Browsertrix Crawler releases 1.1.0 and later.

## Getting started

To analyze an existing crawl, call Browsertrix Crawler with the `qa` entrypoint, passing the original crawl WACZ as the `qaSource`:

```sh
docker run -v $PWD/crawls/:/crawls/ -it webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/example-crawl/example-crawl.wacz --collection example-qa
```

This will result in a new WACZ for the analysis run in the resulting `example-qa` collection.

## Comparison Dimensions

### Screenshot Match

Assuming that the original crawl was produced with the `--screenshot view` option, the initial viewport screenshots of each page from the crawl and replay are compared on the basis of matching pixel count. This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay screenshots for each page.

### Text Match

Assuming that the original crawl was produced with the `--text to-warc` option, extracted text of each page from the crawl and replay are compared on the basis of [Levenshtein distance](https://en.wikipedia.org/wiki/Levenshtein_distance). This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay text for each page.

### Resources

The `pageinfo` records produced by the crawl and analysis runs contain a JSON document containing information about the resources loaded on each page, such as CSS stylesheets, JavaScript scripts, fonts, images, and videos.

In addition to the status code, MIME type, and resource type for each resource, the `pageinfo` records produced by the analysis run additionally include overall resource counts. These counts are divided between "good" (2xx or 3xx status code) and "bad" (4xx or 5xx status code), as well as crawl and replay.
