# Reports

Browsertrix has the option to generate optional reports with each crawl. The following reports are currently available.
Browsertrix has the option to generate optional reports with each crawl. All reports are in the JSONL format, with one JSON entry per line. The following reports are currently available.

## Skipped Pages Report

Written to `reports/skippedPages.jsonl` and enabled with `--reportSkipped`, this report is in the same format as the `pages/pages.jsonl` file, but lists pages that were either never loaded or where page loading was immediately aborted and no content was archived from that page.

Each line in the report contains the following:

- `url`: Page URL
- `ts`: The ISO Date of the time the page was encountered
- `seedUrl`: The seed URL that this page was discovered from
- `depth`: The depth of the page if it were to be crawled
- `seed`: true|false if the page is a seed
- `reason`: Reason for skipping this page

### Skip Reasons

The `reason` may be one of the following:

- `outOfScope`: Page URL out of scope according to scoping rules
- `pageLimit`: The limit `--pageLimit` was reached before the page could be crawled
- `robotsTxt`: The page URL has been excluded via robots.txt rules
- `redirectToExcluded`: A special case of `outOfScope` where the page URL itself is in scope but loading it resulted in a HTTP redirect to a page that was not in scope, so page loading was aborted
- `duplicate`: The page content is a duplicate and loading was aborted (see [Page Deduplication](./dedupe.md#page-deduplication) for more information)