# Reports

Browsertrix has the option to generate optional reports with each crawl. The following reports are currently available.
All reports are in the JSONL format, with one JSON entry per line.

## Skipped Pages Report

Written to `reports/skippedPages.jsonl` ane enabled with `--reportSkipped`, this report is in the same format as the `pages/pages.jsonl` file, but also includes a reason for why the page was skipped. Each line in the report contains the following:

- `url`: Page URL
- `ts`: The ISO Date of the time the page was encountered
- `seedUrl`: The seed URL that this page was discovered from
- `depth`: the depth of the page if it were to be crawled
- `seed`: true|false if the page is a seed
- `reason`: reason for skipping this page.

Skipped pages were either never loaded or page loading was immediately aborted and no content was
archived from those pages.

### Skip Reasons

The `reason` may be one of the following:

- `outOfScope` - page URL out of scope according to scoping rules.
- `pageLimit` - the limit `--pageLimit` has been reached before the page could be crawled.
- `robotsTxt` - the page URL has been excluded via robots.txt rules
- `redirectToExcluded` - a special case of `outOfScope`: the page URL itself is in scope, but loading it resulted in a HTTP redirect to a page that was not in scope, so page loading was aborted.
- `duplicate` - the page content is a duplicate and loading was aborted. See [Page Deduplication](./dedupe.md#page-deduplication) for more info.