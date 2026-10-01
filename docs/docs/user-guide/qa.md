# Quality Assurance

## Overview

Browsertrix Crawler can analyze an existing crawl to compare what the browser encountered on a website during crawling against the replay of the crawl WACZ. The WACZ produced by this analysis run includes additional comparison data (stored as WARC `resource` records) for the pages found during crawling against their replay in ReplayWeb.page. This works along several dimensions, including screenshot, extracted text, and page resource comparisons.

!!! note

    QA features described on this page are available in Browsertrix Crawler releases 1.1.0 and later.

## Getting started

To be able to run QA on a crawl, you must first have an existing crawl, for example:

```sh
docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --url https://webrecorder.net/ --collection example-crawl --text to-warc --screenshot view --generateWACZ
```

Note that this crawl must be run with `--generateWACZ` flag as QA requires a WACZ to work with, and also ideally the `--text to-warc` and `--screenshot view` flags as well (see below for more details on comparison dimensions).

To analyze this crawl, call Browsertrix Crawler with the `qa` entrypoint, passing the original crawl WACZ as the `qaSource`:

```sh
docker run -v $PWD/crawls/:/crawls/ -it webrecorder/browsertrix-crawler qa --qaSource /crawls/collections/example-crawl/example-crawl.wacz --collection example-qa --generateWACZ
```

The `qaSource` can be:
- A local WACZ file path or a URL
- A single WACZ or a JSON file containing a list of WACZ files in the `resources` json (Multi-WACZ)

This assumes an existing crawl that was created in the `example-crawl` collection.

A new WACZ for the analysis run will be created in the resulting `example-qa` collection.

By default, the analysis crawl will visit all of the pages (as read from the source WACZ file(s)), however pages can further be limited by adding `--include` and `--exclude` regexes. The `--limit` flag will also limit how many pages are tested.

The analysis crawl will skip over any non-HTML pages such as PDFs which can be relied upon to be bit-for-bit identical as long as the resource was fully fetched.

## Comparison Dimensions

### Screenshot Match

One way to compare crawl and replay is to compare the screenshots of a page while it is being crawled with when it is being replayed. The initial viewport screenshots of each page from the crawl and replay are compared on the basis of pixel value similarity. This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay screenshots for each page. The screenshots are stored in `urn:view:<url>` WARC resource records.

To enable comparison on this dimension, the crawl must be run with at least the `--screenshot view` option. (Additional screenshot options can be added as well).

### Text Match

Another way to compare the crawl and replay results is to use the text extracted from the HTML. This is done by comparing the extracted text from crawl and replay on the basis of [Levenshtein distance](https://en.wikipedia.org/wiki/Levenshtein_distance). This results in a score between 0 and 1.0 representing the percentage match between the crawl and replay text for each page. The extracted text is stored in `urn:text:<url>` WARC resource records.

To enable comparison on this dimension, the original crawl must be run with at least the `--text to-warc` option. (Additional text options can be added as well)

### Resources and Page Info

The `pageinfo` records produced by the crawl and analysis runs include a JSON document containing information about the resources loaded on each page, such as CSS stylesheets, JavaScript scripts, fonts, images, and videos. The URL, status code, MIME type, and resource type of each resource is saved in the `pageinfo` record for each page.

Since `pageinfo` records are produced for all crawls, this data is always available.

### Comparison Data

Comparison data is also added to the QA crawl's `pageinfo` records. The comparison data may look as follows:

```json
"comparison": {
  "screenshotMatch": 0.95,
  "textMatch": 0.9,
  "resourceCounts": {
    "crawlGood": 10,
    "crawlBad": 0,
    "replayGood": 9,
    "replayBad": 1
  }
}
```

This data indicates that:

- When comparing `urn:view:<url>` records for crawl and replay, the screenshots are 95% similar.
- When comparing `urn:text:<url>` records from crawl and replay WACZs, the text is 90% similar.
- When comparing `urn:pageinfo:<url>` resource entries from crawl and replay, the crawl record had 10 good responses (2xx/3xx status code) and 0 bad responses (4xx/5xx status code), while replay had 9 good and 1 bad.

## QA Filtering and Sampling

Additional crawler flags can be used to further customize the QA process. These includes the ability to:
- set total number of pages to QA
- randomly sample pages to QA instead of loading pages in order they were captured.
- filtering pages to QA by regex(s)

### Limiting Pages to QA

By using the `--pageLimit N` option, the QA run will be limited to the first N pages, in the order
the pages were crawled. To QA first 10 pages, use:

    --pageLimit 10

### Random Sampling pages

By using `--qaRandom` along with `--pageLimit`, it is possible to specify a random sample of N
pages from the entire crawl. Each page has an equal chance of being selected.
To QA 10 *randomly selected* pages from a crawl, use:

    --qaRandom --pageLimit 10

The random selection uses reservoir sampling to select exactly N pages.
Using `--qaRandom` without specifying how many pages to sample will result in an immediate error.

### Filtering pages

Existing crawler scoping options, `--scopeIncludeRx`/`--include` and `--scopeIncludeRx`/`--exclude` can be used
to only include or exclude certain pages from the QA process.

For example, the following will match pages from the crawl that start contain `example.com/R` or `example.org/S`:

    --include=example.com/R --include=example.org/S

These options can also combined with `--pageLimit` and `--qaRandom` to filter from the random selection of pages.
To filter the pages by regex, and select at most 10 at random from the matching list, use.

    --include=example.com/R --include=example.org/S --qaRandom --pageLimit 10

Note that pages are filtered by inclusion/exclusion regexes first, and the selected (either in order or randomly).

## Usage with the Browsertrix UI

A future release of [Browsertrix](https://github.com/webrecorder/browsertrix) will likely integrate these settings into the Browsertrix application's user interface. In the meantime, it is possible to use these features with a [self-hosted deployment](https://docs.browsertrix.com/deploy/) of Browsertrix in the following manner:

  1. Build the crawler Docker image as usual.
  2. Tag it as you wish and push it to local registry.
  3. Adapt the `crawler_channels` in your deployment's `local-config.yaml` file so that it points to the crawler in your registry.
  4. Add any QA-specific options to the `qa_crawler_extra_args` helm chart value.
  5. (optional) Clear your Kubernetes/microk8s cache with `microk8s ctr images rm localhost:32000/<your-crawler-image>`.
  6. Reload your deployment.

For example, to limit Browsertrix QA to 10 random pages, in your local helm chart `local-config.yaml`, set:

    qa_crawler_extra_args: --qaRandom --pagelimit 10

Now, whenever you start a new QA workflow from the Browsertrix interface, the QA run crawler instance will be started
with these additional parameters.

Note: The `qa_crawler_extra_args` option requires Browsertrix 1.26+.
