# Commonly-Used Options

## Waiting for Page Load

One of the key nuances of browser-based crawling is determining when a page is finished loading. This can be configured with the `--waitUntil` flag.

The default is `load,networkidle2`, which waits until page load and ≤2 requests remain, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example). `--waitUntil networkidle0` may make sense for sites where absolutely all requests must be waited until before proceeding.

See [page.goto waitUntil options](https://pptr.dev/api/puppeteer.page.goto#remarks) for more info on the options that can be used with this flag from the Puppeteer docs.

The `--pageLoadTimeout`/`--timeout` option sets the timeout in seconds for page load, defaulting to 90 seconds. Behaviors will run on the page once either the page load condition or the page load timeout is met, whichever happens first.

## Ad Blocking

Brave Browser, the browser used by Browsertrix Crawler for crawling, has some ad and tracker blocking features enabled by default. These [Shields](https://brave.com/shields/) be disabled or customized using [Browser Profiles](browser-profiles.md).

Browsertrix Crawler also supports blocking ads from being loaded during capture based on [Stephen Black's list of known ad hosts](https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts). To enable ad blocking based on this list, use the `--blockAds` option. If `--adBlockMessage` is set, a record with the specified error message will be added in the ad's place.

## Sitemap Parsing

The `--sitemap` option can be used to have the crawler parse a sitemap and queue any found URLs while respecting the crawl's scoping rules and limits. Browsertrix Crawler is able to parse regular sitemaps as well as sitemap indices that point out to nested sitemaps.

By default, `--sitemap` will look for a sitemap at `<your-seed>/sitemap.xml`. If a website's sitemap is hosted at a different URL, pass the URL with the flag like `--sitemap <sitemap url>`.

The `--sitemapFrom`/`--sitemapFromDate` and `--sitemapTo`/`--sitemapToDate` options allow for only extracting pages within a specific date range. If set, these options will filter URLs from sitemaps to those greater than or equal to (>=) or lesser than or equal to (<=) a provided ISO Date string (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, or partial date), respectively.

## Custom Warcinfo Fields

Custom fields can be added to the `warcinfo` WARC record, generated for each combined WARC. The fields can be specified in the YAML config under `warcinfo` section or specifying individually via the command-line.

For example, the following are equivalent ways to add additional warcinfo fields:

via yaml config:

```yaml
warcinfo:
  operator: my-org
  hostname: hostname.my-org
```

via command-line:

```sh
--warcinfo.operator my-org --warcinfo.hostname hostname.my-org

```

## Screenshots

Browsertrix Crawler includes the ability to take screenshots of each page crawled via the `--screenshot` option.

Three screenshot options are available:

- `--screenshot view`: Takes a png screenshot of the initially visible viewport (1920x1080)
- `--screenshot fullPage`: Takes a png screenshot of the full page
- `--screenshot thumbnail`: Takes a jpeg thumbnail of the initially visible viewport (1920x1080)

These can be combined using a comma-separated list passed via the `--screenshot` option, e.g.: `--screenshot thumbnail,view,fullPage` or passed in separately `--screenshot thumbnail --screenshot view --screenshot fullPage`.

Screenshots are written into a `screenshots.warc.gz` WARC file in the `archives/` directory. If the `--generateWACZ` command line option is used, the screenshots WARC is written into the `archive` directory of the WACZ file and indexed alongside the other WARCs.

## Screencasting

Browsertrix Crawler includes a screencasting option which allows watching the crawl in real-time via screencast (connected via a websocket).

To enable, add `--screencastPort` command-line option and also map the port on the docker container. An example command might be:

```sh
docker run -p 9037:9037 -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl  --url https://www.example.com --screencastPort 9037
```

Then, open `http://localhost:9037/` and watch the crawl!

## Text Extraction

Browsertrix Crawler supports text extraction via the `--text` flag, which accepts one or more of the following extraction options:

- `--text to-pages` — Extract initial text and add it to the text field in pages.jsonl
- `--text to-warc` — Extract initial page text and add it to a `urn:text:<url>` WARC resource record
- `--text final-to-warc` — Extract the final page text after all behaviors have run and add it to a `urn:textFinal:<url>` WARC resource record

The options can be separate or combined into a comma separate list, eg. `--text to-warc,final-to-warc` or `--text to-warc --text final-to-warc`
are equivalent. For backwards compatibility, `--text` alone is equivalent to `--text to-pages`.

## Uploading Crawl Outputs to S3-Compatible Storage

Browsertrix Crawler includes support for uploading WACZ files to S3-compatible storage, and notifying a webhook when the upload succeeds.

S3 upload is only supported when WACZ output is enabled and will not work for WARC output.

This feature can currently be enabled by setting environment variables (for security reasons, these settings are not passed in as part of the command-line or YAML config at this time).

Environment variables for S3-uploads include:

- `STORE_ACCESS_KEY` / `STORE_SECRET_KEY` — S3 credentials
- `STORE_ENDPOINT_URL` — S3 endpoint URL
- `STORE_PATH` — optional path appended to endpoint, if provided
- `STORE_FILENAME` — filename or template for filename to put on S3
- `STORE_USER` — optional username to pass back as part of the webhook callback
- `CRAWL_ID` — unique crawl id (defaults to container hostname)
- `WEBHOOK_URL` — the URL of the webhook (can be http://, https://, or redis://)

### Webhook Notification

The webhook URL can be an HTTP URL which receives a JSON POST request OR a Redis URL, which specifies a redis list key to which the JSON data is pushed as a string.

Webhook notification JSON includes:

- `id` — crawl id (value of `CRAWL_ID`)
- `userId` — user id (value of `STORE_USER`)
- `filename` — bucket path + filename of the file
- `size` — size of WACZ file
- `hash` — SHA-256 of WACZ file
- `completed` — boolean of whether crawl fully completed or partially (due to interrupt signal or other error).

## Saving Crawl State: Interrupting and Restarting the Crawl

A crawl can be gracefully interrupted with Ctrl-C (SIGINT) or a SIGTERM (see below for more details).

When a crawl is interrupted, the current crawl state is written to the `crawls` subdirectory inside the collection directory. The crawl state includes the current YAML config, if any, plus the current state of the crawl.

This crawl state YAML file can then be used as `--config` option to restart the crawl from where it was left of previously.

By default, the crawl interruption waits for current pages to finish. A subsequent SIGINT will cause the crawl to stop immediately. Any unfinished pages are recorded in the `pending` section of the crawl state (if gracefully finished, the section will be empty).

By default, the crawl state is only written when a crawl is interrupted before completing. The `--saveState` cli option can be set to `always` or `never` respectively, to control when the crawl state file should be written.

### Periodic State Saving

When the `--saveState` is set to always, Browsertrix Crawler will also save the state automatically during the crawl, as set by the `--saveStateInterval` setting. The crawler will keep the last `--saveStateHistory` save states and delete older ones. This provides extra backup, in the event that the crawl fails unexpectedly or is not terminated via Ctrl-C, several previous crawl states are still available.

## Crawl Interruption Options

Browsertrix Crawler has different crawl interruption modes, and does everything it can to ensure the WARC data written is always valid when a crawl is interrupted. The following are three interruption scenarios:

### 1. Graceful Shutdown

Initiated when a single SIGINT (Ctrl+C) or SIGTERM (`docker kill -s SIGINT`, `docker kill -s SIGTERM`, `kill`) signal is received.
The crawler will attempt to finish current pages, finish any pending async requests, write all WARCS, generate WACZ files
and other post-processing, save state from Redis and then exit.

### 2. Less-Graceful, Quick Shutdown

If a second SIGINT / SIGTERM is received, the crawler will close the browser immediately, interrupting any on-going network requests.
Any asynchronous fetching will not be finished. However, anything in the WARC queue will be written and WARC files will be flushed.
WACZ files and other post-processing will not be generated, but the current state from Redis will still be saved if enabled (see above).
WARC records should be fully finished and WARC file should be valid, though not necessarily contain all the data for the pages being processed during the interruption.

### 3. Violent / Immediate Shutdown

If a crawler is killed, eg. with SIGKILL signal (`docker kill`, `kill -9`), the crawler container / process will be immediately shut down. It will not have a chance to finish any WARC files, and there is no guarantee that WARC files will be valid, but the crawler will of course exit right away.


### Recommendations

It is recommended to gracefully stop the crawler by sending a SIGINT or SIGTERM signal, which can be done via Ctrl+C or `docker kill -s SIGINT <containerid>`. Repeating the command will result in a faster, slightly less-graceful shutdown.
Using SIGKILL is not recommended
except for last resort, and only when data is to be discarded.
