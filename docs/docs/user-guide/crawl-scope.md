# Crawl Scope

## Configuring Pages Included or Excluded from a Crawl

The crawl scope can be configured globally for all seeds, or customized per seed, by specifying the `--scopeType` command-line option or setting the `type` property for each seed.

There is also a `depth` setting also limits how many pages will be crawled for that seed, while the `limit` option sets the total number of pages crawled from any seed.

The scope controls which linked pages are included and which pages are excluded from the crawl.

To make this configuration as simple as possible, there are several predefined scope types. The available types are:

- `page` — crawl only this page and no additional links.

- `page-spa` — crawl only this page, but load any links that include different hashtags. Useful for single-page apps that may load different content based on hashtag.

- `prefix` — crawl any pages in the same directory, eg. starting from `https://example.com/path/page.html`, crawl anything under `https://example.com/path/` (default)

- `host` — crawl pages that share the same host.

- `domain` — crawl pages that share the same domain and subdomains, eg. given `https://example.com/` will also crawl `https://anysubdomain.example.com/`

- `any` — crawl any and all pages linked from this page..

- `custom` — crawl based on the `--include` regular expression rules.

The scope settings for multi-page crawls (page-spa, prefix, host, domain) also include http/https versions, eg. given a prefix of `http://example.com/path/`,
`https://example.com/path/` is also included.

## Custom Scope Inclusion Rules

Instead of setting a scope type, it is possible to instead configure custom scope regex by setting `--include` config to one or more regular expressions. If using the YAML config, the `include` field can contain a list of regexes.

Extracted links that match the regular expression will be considered 'in scope' and included.

## Custom Scope Exclusion Rules

In addition to the inclusion rules, Browsertrix Crawler supports a separate list of exclusion regexes, that if match, override an exclude a URL from the crawl.

The exclusion regexes are often used with a custom scope, but could be used with a predefined scopeType as well.

## Extra 'Hops' Beyond Current Scope

Occasionally, it may be useful to augment the scope by allowing extra links N 'hops' beyond the current scope.

For example, this is most useful when crawling with a `host` or `prefix` scope, but also wanting to include 'one extra hop' - any link to external pages beyond the current host, but not following those links. This is now possible with the `extraHops` setting, which defaults to 0, but can be set to a higher value N (usually 1) to go beyond the current scope.

The `--extraHops` setting can be set globally or per seed to allow expanding the current inclusion scope N 'hops' beyond the configured scope. Note that this mechanism only expands the inclusion scope, and any exclusion rules are still applied. If a URL is to be excluded via the exclusion rules,
that will take precedence over the `--extraHops`.

## Scope Rule Examples

For example, the following seed will start on `https://example.com/startpage.html` and crawl all pages on the `https://example.com/` domain, except pages that match the regexes `example.com/skip.*` or `example.com/search.*`

```yaml
seeds:
  - url: https://example.com/startpage.html
    scopeType: "host"
    exclude:
      - example.com/skip.*
      - example.com/search.*

```

In the following example, the scope include regexes will crawl all page URLs that match `example.com/(crawl-this|crawl-that)`,
but skip URLs that end with 'skip-me'. For example, `https://example.com/crawl-this/page.html` would be crawled, but `https://example.com/crawl-this/pages/skip` would not be.

```yaml
seeds:
  - url: https://example.com/startpage.html
    include: example.com/(crawl-this|crawl-that)
    exclude:
      - skip$
```

The `include`, `exclude`, `scopeType` and `depth` settings can be configured per seed, or globally, for the entire crawl.

The per-seed settings override the per-crawl settings, if any.

See the test suite [tests/scopes.test.js](https://github.com/webrecorder/browsertrix-crawler/blob/main/tests/scopes.test.js) for additional examples of configuring scope inclusion and exclusion rules.

## Page Resource Block Rules

While scope rules define which pages are to be crawled, it is also possible to block page resources, URLs loaded within a page or within an iframe on a page.

For example, this is useful for blocking ads or other content that is loaded within multiple pages, but should be blocked.

The page rules block rules can be specified as a list in the `blockRules` field. Each rule can contain one of the following fields:

- `url`: regex for URL to match (required)

- `type`: can be `block` or `allowOnly`. The block rule blocks the specified match, while allowOnly inverts the match and allows only the matched URLs, while blocking all others.

- `inFrameUrl`: if specified, indicates that the rule only applies when `url` is loaded in a specific iframe or top-level frame.

- `frameTextMatch`: if specified, the text of the specified URL is checked for the regex, and the rule applies only if there is an additional match. When specified, this field makes the block rule apply only to frame-level resource, eg. URLs loaded directly in an iframe or top-level frame.

For example, a very simple block rule that blocks all URLs from 'googleanalytics.com' on any page can be added with:

```yaml
blockRules:
   - url: googleanalytics.com
```

To instead block 'googleanalytics.com' only if loaded within pages or iframes that match the regex 'example.com/no-analytics', add:

```yaml
blockRules:
   - url: googleanalytics.com
     inFrameUrl: example.com/no-analytics
```

For additional examples of block rules, see the [tests/blockrules.test.js](https://github.com/webrecorder/browsertrix-crawler/blob/main/tests/blockrules.test.js) file in the test suite.

If the `--blockMessage` is also specified, a blocked URL is replaced with the specified message (added as a WARC resource record).

## Page Resource Block Rules vs Scope Rules

If it seems confusing which rules should be used, here is a quick way to determine:

- If you'd like to restrict _the pages that are being crawled_, use the crawl scope rules (defined above).

- If you'd like to restrict _parts of a page_ that are being loaded, use the page resource block rules described in this section.

The blockRules add a filter to each URL loaded on a page and incur an extra overhead. They should only be used in advanced use cases where part of a page needs to be blocked.

These rules can not be used to prevent entire pages for loading -- use the scope exclusion rules for that (a warning will be printed if a page resource block rule matches a top-level page).
