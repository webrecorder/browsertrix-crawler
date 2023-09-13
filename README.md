# Browsertrix Crawler

Browsertrix Crawler is a simplified (Chrome) browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [Puppeteer](https://github.com/puppeteer/puppeteer) to control one or more browser windows in parallel.

## Features

Thus far, Browsertrix Crawler supports:

- Single-container, browser based crawling with a headless/headful browser running pages in multiple windows.
- Support for custom browser behaviors, using [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) including autoscroll, video autoplay and site-specific behaviors.
- YAML-based configuration, passed via file or via stdin.
- Seed lists and per-seed scoping rules.
- URL blocking rules to block capture of specific URLs (including by iframe URL and/or by iframe contents).
- Screencasting: Ability to watch crawling in real-time (experimental).
- Screenshotting: Ability to take thumbnails, full page screenshots, and/or screenshots of the initial page view.
- Optimized (non-browser) capture of non-HTML resources.
- Extensible Puppeteer driver script for customizing behavior per crawl or page.
- Ability to create and reuse browser profiles interactively or via automated user/password login using an embedded browser.
- Multi-platform support -- prebuilt Docker images available for Intel/AMD and Apple Silicon (M1/M2) CPUs.

## Getting Started

Browsertrix Crawler requires [Docker](https://docs.docker.com/get-docker/) to be installed on the machine running the crawl.

Assuming Docker is installed, you can run a crawl and test your archive with the following steps.

You don't even need to clone this repo, just choose a directory where you'd like the crawl data to be placed, and then run
the following commands. Replace `[URL]` with the web site you'd like to crawl.

1. Run `docker pull webrecorder/browsertrix-crawler`
2. `docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --url [URL] --generateWACZ --text --collection test`
3. The crawl will now run and logs in [JSON Lines](https://jsonlines.org/) format will be output to the console. Depending on the size of the site, this may take a bit!
4. Once the crawl is finished, a WACZ file will be created in `crawls/collection/test/test.wacz` from the directory you ran the crawl!
5. You can go to [ReplayWeb.page](https://replayweb.page) and open the generated WACZ file and browse your newly crawled archive!

Here's how you can use some of the command-line options to configure the crawl:

- To include automated text extraction for full text search, add the `--text` flag.

- To limit the crawl to a maximum number of pages, add `--pageLimit P` where P is the number of pages that will be crawled.

- To limit the crawl to a maximum size, set `--sizeLimit` (size in bytes)

- To limit the crawl time, set `--timeLimit` (in seconds)

- To run more than one browser worker and crawl in parallel, and `--workers N` where N is number of browsers to run in parallel. More browsers will require more CPU and network bandwidth, and does not guarantee faster crawling.

- To crawl into a new directory, specify a different name for the `--collection` param, or, if omitted, a new collection directory based on current time will be created. Adding the `--overwrite` flag will delete the collection directory at the start of the crawl, if it exists.

Browsertrix Crawler includes a number of additional command-line options, explained below.

## Crawling Configuration Options


<details>
      <summary><b>The Browsertrix Crawler docker image currently accepts the following parameters:</b></summary>

```
Options:
      --help                                Show help                  [boolean]
      --version                             Show version number        [boolean]
      --seeds, --url                        The URL to start crawling from
                                                           [array] [default: []]
      --seedFile, --urlFile                 If set, read a list of seed urls, on
                                            e per line, from the specified
                                                                        [string]
  -w, --workers                             The number of workers to run in para
                                            llel           [number] [default: 1]
      --crawlId, --id                       A user provided ID for this crawl or
                                             crawl configuration (can also be se
                                            t via CRAWL_ID env var)
                                              [string] [default: "7760c6c5f6ca"]
      --newContext                          Deprecated as of 0.8.0, any values p
                                            assed will be ignored
                                                        [string] [default: null]
      --waitUntil                           Puppeteer page.goto() condition to w
                                            ait for before continuing, can be mu
                                            ltiple separated by ','
                                                  [default: "load,networkidle2"]
      --depth                               The depth of the crawl for all seeds
                                                          [number] [default: -1]
      --extraHops                           Number of extra 'hops' to follow, be
                                            yond the current scope
                                                           [number] [default: 0]
      --pageLimit, --limit                  Limit crawl to this number of pages
                                                           [number] [default: 0]
      --maxPageLimit                        Maximum pages to crawl, overriding
                                            pageLimit if both are set
                                                           [number] [default: 0]
      --pageLoadTimeout, --timeout          Timeout for each page to load (in se
                                            conds)        [number] [default: 90]
      --scopeType                           A predefined scope of the crawl. For
                                             more customization, use 'custom' an
                                            d set scopeIncludeRx regexes
  [string] [choices: "page", "page-spa", "prefix", "host", "domain", "any", "cus
                                                                           tom"]
      --scopeIncludeRx, --include           Regex of page URLs that should be in
                                            cluded in the crawl (defaults to the
                                             immediate directory of URL)
      --scopeExcludeRx, --exclude           Regex of page URLs that should be ex
                                            cluded from the crawl.
      --allowHashUrls                       Allow Hashtag URLs, useful for singl
                                            e-page-application crawling or when
                                            different hashtags load dynamic cont
                                            ent
      --blockRules                          Additional rules for blocking certai
                                            n URLs from being loaded, by URL reg
                                            ex and optionally via text match in
                                            an iframe      [array] [default: []]
      --blockMessage                        If specified, when a URL is blocked,
                                             a record with this error message is
                                             added instead              [string]
      --blockAds, --blockads                If set, block advertisements from be
                                            ing loaded (based on Stephen Black's
                                             blocklist)
                                                      [boolean] [default: false]
      --adBlockMessage                      If specified, when an ad is blocked,
                                             a record with this error message is
                                             added instead              [string]
  -c, --collection                          Collection name to crawl to (replay
                                            will be accessible under this name i
                                            n pywb preview)
                                                 [string] [default: "crawl-@ts"]
      --headless                            Run in headless mode, otherwise star
                                            t xvfb    [boolean] [default: false]
      --driver                              JS driver for the crawler
                                        [string] [default: "./defaultDriver.js"]
      --generateCDX, --generatecdx, --gene  If set, generate index (CDXJ) for us
      rateCdx                               e with pywb after crawl is done
                                                      [boolean] [default: false]
      --combineWARC, --combinewarc, --comb  If set, combine the warcs
      ineWarc                                         [boolean] [default: false]
      --rolloverSize                        If set, declare the rollover size
                                                  [number] [default: 1000000000]
      --generateWACZ, --generatewacz, --ge  If set, generate wacz
      nerateWacz                                      [boolean] [default: false]
      --logging                             Logging options for crawler, can inc
                                            lude: stats (enabled by default), js
                                            errors, pywb, debug
                                                     [string] [default: "stats"]
      --logLevel                            Comma-separated list of log levels t
                                            o include in logs
                                                          [string] [default: ""]
      --context                             Comma-separated list of contexts to
                                            include in logs
                                                          [string] [default: ""]
      --text                                If set, extract text to the pages.js
                                            onl file  [boolean] [default: false]
      --cwd                                 Crawl working directory for captures
                                             (pywb root). If not set, defaults t
                                            o process.cwd()
                                                   [string] [default: "/crawls"]
      --mobileDevice                        Emulate mobile device by name from:
                                            https://github.com/puppeteer/puppete
                                            er/blob/main/src/common/DeviceDescri
                                            ptors.ts                    [string]
      --userAgent                           Override user-agent with specified s
                                            tring                       [string]
      --userAgentSuffix                     Append suffix to existing browser us
                                            er-agent (ex: +MyCrawler, info@examp
                                            le.com)                     [string]
      --useSitemap, --sitemap               If enabled, check for sitemaps at /s
                                            itemap.xml, or custom URL if URL is
                                            specified
      --statsFilename                       If set, output stats as JSON to this
                                             file. (Relative filename resolves t
                                            o crawl working directory)
      --behaviors                           Which background behaviors to enable
                                             on each page
                [string] [default: "autoplay,autofetch,autoscroll,siteSpecific"]
      --behaviorTimeout                     If >0, timeout (in seconds) for in-p
                                            age behavior will run on each page.
                                            If 0, a behavior can run until finis
                                            h.            [number] [default: 90]
      --pageExtraDelay, --delay             If >0, amount of time to sleep (in s
                                            econds) after behaviors before movin
                                            g on to next page
                                                           [number] [default: 0]
      --dedupPolicy                         Deduplication policy
                 [string] [choices: "skip", "revisit", "keep"] [default: "skip"]
      --profile                             Path to tar.gz file which will be ex
                                            tracted and used as the browser prof
                                            ile                         [string]
      --screenshot                          Screenshot options for crawler, can
                                            include: view, thumbnail, fullPage (
                                            comma-separated list)
                                                          [string] [default: ""]
      --screencastPort                      If set to a non-zero value, starts a
                                            n HTTP server with screencast access
                                            ible on this port
                                                           [number] [default: 0]
      --screencastRedis                     If set, will use the state store red
                                            is pubsub for screencasting. Require
                                            s --redisStoreUrl to be set
                                                      [boolean] [default: false]
      --warcInfo, --warcinfo                Optional fields added to the warcinf
                                            o record in combined WARCs
      --redisStoreUrl                       If set, url for remote redis server
                                            to store state. Otherwise, using in-
                                            memory store
                                  [string] [default: "redis://localhost:6379/0"]
      --saveState                           If the crawl state should be seriali
                                            zed to the crawls/ directory. Defaul
                                            ts to 'partial', only saved when cra
                                            wl is interrupted
           [string] [choices: "never", "partial", "always"] [default: "partial"]
      --saveStateInterval                   If save state is set to 'always', al
                                            so save state during the crawl at th
                                            is interval (in seconds)
                                                         [number] [default: 300]
      --saveStateHistory                    Number of save states to keep during
                                             the duration of a crawl
                                                           [number] [default: 5]
      --sizeLimit                           If set, save state and exit if size
                                            limit exceeds this value
                                                           [number] [default: 0]
      --diskUtilization                     If set, save state and exit if disk
                                            utilization exceeds this percentage
                                            value         [number] [default: 90]
      --timeLimit                           If set, save state and exit after ti
                                            me limit, in seconds
                                                           [number] [default: 0]
      --healthCheckPort                     port to run healthcheck on
                                                           [number] [default: 0]
      --overwrite                           overwrite current crawl data: if set
                                            , existing collection directory will
                                             be deleted before crawl is started
                                                      [boolean] [default: false]
      --waitOnDone                          if set, wait for interrupt signal wh
                                            en finished instead of exiting
                                                      [boolean] [default: false]
      --netIdleWait                         if set, wait for network idle after
                                            page load and after behaviors are do
                                            ne (in seconds). if -1 (default), de
                                            termine based on scope
                                                          [number] [default: -1]
      --lang                                if set, sets the language used by th
                                            e browser, should be ISO 639 languag
                                            e[-country] code            [string]
      --title                               If set, write supplied title into WA
                                            CZ datapackage.json metadata[string]
      --description, --desc                 If set, write supplied description i
                                            nto WACZ datapackage.json metadata
                                                                        [string]
      --originOverride                      if set, will redirect requests from
                                            each origin in key to origin in the
                                            value, eg. --originOverride https://
                                            host:port=http://alt-host:alt-port
                                                           [array] [default: []]
      --logErrorsToRedis                    If set, write error messages to redi
                                            s         [boolean] [default: false]
      --failOnFailedSeed                    If set, crawler will fail with exit
                                            code 1 if any seed fails
                                                      [boolean] [default: false]
      --config                              Path to YAML config file

```
</details>


### Waiting for Page Load

One of the key nuances of browser-based crawling is determining when a page is finished loading. This can be configured with the `--waitUntil` flag.

The default is `load,networkidle2`, which waits until page load and <=2 requests remain, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example). `--waitUntil networkidle0` may make sense for sites where absolutely all requests must be waited until before proceeding.

See [page.goto waitUntil options](https://pptr.dev/api/puppeteer.page.goto#remarks) for more info on the options that can be used with this flag from the Puppeteer docs.

The `--pageLoadTimeout`/`--timeout` option sets the timeout in seconds for page load, defaulting to 90 seconds. Behaviors will run on the page once either the page load condition or the page load timeout is met, whichever happens first.


### YAML Crawl Config

Browsertix Crawler supports the use of a yaml file to set parameters for a crawl. This can be used by passing a valid yaml file to the `--config` option.
 
The YAML file can contain the same parameters as the command-line arguments. If a parameter is set on the command-line and in the yaml file, the value from the command-line will be used. For example, the following should start a crawl with config in `crawl-config.yaml`.


```
docker run -v $PWD/crawl-config.yaml:/app/crawl-config.yaml -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --config /app/crawl-config.yaml
```

The config can also be passed via stdin, which can simplify the command. Note that this require running `docker run` with the `-i` flag. To read config from stdin, pass `--config stdin`

```
cat ./crawl-config.yaml | docker run -i -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --config stdin
```


An example config file (eg. crawl-config.yaml) might contain:

```
seeds:
  - https://example.com/
  - https://www.iana.org/

combineWARC: true
```

The list of seeds can be loaded via an external file by specifying the filename via the `seedFile` config or command-line option.

#### Seed File

The URL seed file should be a text file formatted so that each line of the file is a url string. (An example file is available in the fixture folder as urlSeedFile.txt)

The seed file must be passed as a volume to the docker container. To do that, you can format your docker command similar to the following:

```
docker run -v $PWD/seedFile.txt:/app/seedFile.txt -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --seedFile /app/seedFile.txt
```

#### Per-Seed Settings

Certain settings such scope type, scope includes and excludes, and depth can also be configured per seed directly in the YAML file, for example:

```
seeds:
  - url: https://webrecorder.net/
    depth: 1
    scopeType: "prefix"
```

### Crawl Scope -- Configuring Pages Included or Excluded from a Crawl

The crawl scope can be configured globally for all seeds, or customized per seed, by specifying the `--scopeType` command-line option or setting the `type` property for each seed.

There is also a `depth` setting also limits how many pages will be crawled for that seed, while the `limit` option sets the total number of pages crawled from any seed.

The scope controls which linked pages are included and which pages are excluded from the crawl.

To make this configuration as simple as possible, there are several predefined scope types. The available types are:

- `page` - crawl only this page and no additional links.

- `page-spa` - crawl only this page, but load any links that include different hashtags. Useful for single-page apps that may load different content based on hashtag.

- `prefix` - crawl any pages in the same directory, eg. starting from `https://example.com/path/page.html`, crawl anything under `https://example.com/path/` (default)

- `host` - crawl pages that share the same host.

- `domain` - crawl pages that share the same domain and subdomains, eg. given `https://example.com/` will also crawl `https://anysubdomain.example.com/`

- `any` - crawl any and all pages linked from this page..

- `custom` - crawl based on the `--include` regular expression rules.

The scope settings for multi-page crawls (page-spa, prefix, host, domain) also include http/https versions, eg. given a prefix of `http://example.com/path/`,
`https://example.com/path/` is also included.


#### Custom Scope Inclusion Rules

Instead of setting a scope type, it is possible to instead configure custom scope regex by setting `--include` config to one or more regular expressions.
If using the YAML config, the `include` field can contain a list of regexes.

Extracted links that match the regular expression will be considered 'in scope' and included.

#### Custom Scope Exclusion Rules

In addition to the inclusion rules, Browsertrix Crawler supports a separate list of exclusion regexes, that if match, override an exclude a URL from the crawl.

The exclusion regexes are often used with a custom scope, but could be used with a predefined scopeType as well.


#### Extra 'Hops' Beyond Current Scope

Occasionally, it may be useful to augment the scope by allowing extra links N 'hops' beyond the current scope.

For example, this is most useful when crawling with a `host` or `prefix` scope, but also wanting to include 'one extra hop' - any link to external pages beyond the current host, but not following those links. This is now possible with the `extraHops` setting, which defaults to 0, but can be set to a higher value N (usually 1) to go beyond the current scope.

The `--extraHops` setting can be set globally or per seed to allow expanding the current inclusion scope N 'hops' beyond the configured scope. Note that this mechanism only expands the inclusion scope, and any exclusion rules are still applied. If a URL is to be excluded via the exclusion rules,
that will take precedence over the `--extraHops`.


#### Scope Rule Examples

For example, the following seed will start on `https://example.com/startpage.html` and crawl all pages on the `https://example.com/` domain, except pages that match the regexes `example.com/skip.*` or `example.com/search.*`

```
seeds:
  - url: https://example.com/startpage.html
    scopeType: "host"
    exclude:
      - example.com/skip.*
      - example.com/search.*

```

In the following example, the scope include regexes will crawl all page URLs that match `example.com/(crawl-this|crawl-that)`,
but skip URLs that end with 'skip-me'. For example, `https://example.com/crawl-this/page.html` would be crawled, but `https://example.com/crawl-this/pages/skip` would not be.

```
seeds:
  - url: https://example.com/startpage.html
    include: example.com/(crawl-this|crawl-that)
    exclude:
      - skip$
```

The `include`, `exclude`, `scopeType` and `depth` settings can be configured per seed, or globally, for the entire crawl.

The per-seed settings override the per-crawl settings, if any.

The test suite [tests/scopes.test.js](tests/scopes.test.js) for additional examples of configuring scope inclusion and exclusion rules.

### Page Resource Block Rules

While scope rules define which pages are to be crawled, it is also possible to block page resources, URLs loaded within a page or within an iframe on a page.

For example, this is useful for blocking ads or other content that is loaded within multiple pages, but should be blocked.

The page rules block rules can be specified as a list in the `blockRules` field. Each rule can contain one of the following fields:

- `url`: regex for URL to match (required)

- `type`: can be `block` or `allowOnly`. The block rule blocks the specified match, while allowOnly inverts the match and allows only the matched URLs, while blocking all others.

- `inFrameUrl`: if specified, indicates that the rule only applies when `url` is loaded in a specific iframe or top-level frame.

- `frameTextMatch`: if specified, the text of the specified URL is checked for the regex, and the rule applies only if there is an additional match. When specified, this field makes the block rule apply only to frame-level resource, eg. URLs loaded directly in an iframe or top-level frame.

For example, a very simple block rule that blocks all URLs from 'googleanalytics.com' on any page can be added with:

```
blockRules:
   - url: googleanalytics.com
```

To instead block 'googleanalytics.com' only if loaded within pages or iframes that match the regex 'example.com/no-analytics', add:

```
blockRules:
   - url: googleanalytics.com
     inFrameUrl: example.com/no-analytics
```

For additional examples of block rules, see the [tests/blockrules.test.js](tests/blockrules.test.js) file in the test suite.

If the `--blockMessage` is also specified, a blocked URL is replaced with the specified message (added as a WARC resource record).

#### Page Resource Block Rules vs Scope Rules

If it seems confusing which rules should be used, here is a quick way to determine:

- If you'd like to restrict *the pages that are being crawled*, use the crawl scope rules (defined above).

- If you'd like to restrict *parts of a page* that are being loaded, use the page resource block rules described in this section.

The blockRules add a filter to each URL loaded on a page and incur an extra overhead. They should only be used in advance uses cases where part of a page needs to be blocked.

These rules can not be used to prevent entire pages for loading -- use the scope exclusion rules for that. (A warning will be printed if a page resource block rule matches a top-level page).


### Ad blocking

With version 0.8.0, Browsertrix Crawler supports blocking ads from being loaded during capture based on [Stephen Black's list of known ad hosts](https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts). To enable ad blocking, use the `--blockAds` option. If `--adBlockMessage` is set, a record with the specified error message will be added in the ad's place.


### Custom Warcinfo Fields

Custom fields can be added to the `warcinfo` WARC record, generated for each combined WARCs. The fields can be specified in the YAML config under `warcinfo` section or specifying individually via the command-line.

For example, the following are equivalent ways to add additional warcinfo fields:


via yaml config:

```yaml
warcinfo:
  operator: my-org
  hostname: hostname.my-org
```

via command-line:

```
--warcinfo.operator my-org --warcinfo.hostname hostname.my-org

```

### Behaviors

Browsertrix Crawler also supports automatically running customized in-browser behaviors. The behaviors auto-play videos (when possible), and auto-fetch content that is not loaded by default, and also run custom behaviors on certain sites.

Behaviors to run can be specified via a comma-separated list passed to the `--behaviors` option. All behaviors are enabled by default, the equivalent of `--behaviors autoscroll,autoplay,autofetch,siteSpecific`. To enable only a single behavior, such as autoscroll, use `--behaviors autoscroll`.

The site-specific behavior (or autoscroll) will start running after the page is finished its initial load (as defined by the `--waitUntil` settings). The behavior will then run until finished or until the behavior timeout is exceeded. This timeout can be set (in seconds) via the `--behaviorTimeout` flag (90 seconds by default). Setting the timeout to 0 will allow the behavior to run until it is finished.

See [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for more info on all of the currently available behaviors.

With version 0.9.0, Browsertrix Crawler includes a `--pageExtraDelay`/`--delay` option, which can be used to have the crawler sleep for a configurable number of seconds after behaviors before moving on to the next page.

### Additional Custom Behaviors

Custom behaviours can now also be mounted into the crawler and loaded from there. For example:

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors /custom-behaviors/
```

This will load all the custom behaviors stored in the `tests/custom-behaviors` directory. The first behavior which returns true for `isMatch()` will be run on a given page.
Each behavior should container a single class that implements the behavior interface. See [the behaviors tutorial](https://github.com/webrecorder/browsertrix-behaviors/blob/main/docs/TUTORIAL.md) for more info on how to write behaviors.

### Screenshots

With version 0.8.0, Browsertrix Crawler includes the ability to take screenshots of each page crawled via the `--screenshot` option.

Three screenshot options are available:

- `--view`: Takes a png screenshot of the initially visible viewport (1920x1080)
- `--fullPage`: Takes a png screenshot of the full page
- `--thumbnail`: Takes a jpeg thumbnail of the initially visible viewport (1920x1080)

These can be combined using a comma-separated list passed to the `--screenshot` option, e.g.: `--screenshot thumbnail,view,fullPage`.

Screenshots are written into a `screenshots.warc.gz` WARC file in the `archives/` directory. If the `--generateWACZ` command line option is used, the screenshots WARC is written into the `archive` directory of the WACZ file and indexed alongside the other WARCs.

### Watching the crawl -- Screencasting

With version 0.4.0, Browsertrix Crawler includes an experimental 'screencasting' option, which allows watching the crawl in real-time via screencast (connected via a websocket).

To enable, add `--screencastPort` command-line option and also map the port on the docker container. An example command might be:

```
docker run -p 9037:9037 -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl  --url https://www.example.com --screencastPort 9037
```

Then, you can open `http://localhost:9037/` and watch the crawl.

### Uploading crawl output to S3-Compatible Storage

Browsertrix Crawler also includes support for uploading WACZ files to S3-compatible storage, and notifying a webhook when the upload succeeds.

(At this time, S3 upload is supported only when WACZ output is enabled, but WARC uploads may be added in the future).

This feature can currently be enabled by setting environment variables (for security reasons, these settings are not passed in as part of the command-line or YAML config at this time).

<details>

<summary>Environment variables for S3-uploads include:</summary>

- `STORE_ACCESS_KEY` / `STORE_SECRET_KEY` - S3 credentials
- `STORE_ENDPOINT_URL` - S3 endpoint URL
- `STORE_PATH` - optional path appended to endpoint, if provided
- `STORE_FILENAME` - filename or template for filename to put on S3
- `STORE_USER` - optional username to pass back as part of the webhook callback
- `CRAWL_ID` - unique crawl id (defaults to container hostname)
- `WEBHOOK_URL` - the URL of the webhook (can be http://, https:// or redis://)

</details>

#### Webhook Notification

The webhook URL can be an HTTP URL which receives a JSON POST request OR a Redis URL, which specifies a redis list key to which the JSON data is pushed as a string.

<details>

<summary>Webhook notification JSON includes:</summary>

- `id` - crawl id (value of `CRAWL_ID`)
- `userId` - user id (value of `STORE_USER`)
- `filename` - bucket path + filename of the file
- `size` - size of WACZ file
- `hash` - SHA-256 of WACZ file
- `completed` - boolean of whether crawl fully completed or partially (due to interrupt signal or other error).

</details>

### Configuring Chromium / Puppeteer / pywb

There is a few environment variables you can set to configure chromium and pywb:

- CHROME_FLAGS will be split by spaces and passed to Chromium (via `args` in Puppeteer). Note that setting some options is not supported such as `--proxy-server` since they are set by browsertrix itself.
- SOCKS_HOST and SOCKS_PORT are read by pywb to proxy upstream traffic

Here's some examples use cases:

**Set a socks proxy so outgoing traffic is routed via ssh**

The SOCKS_HOST and SOCKS_PORT env variables are read by [pywb](https://pywb.readthedocs.io/en/latest/manual/configuring.html?highlight=SOCKS#socks-proxy-for-live-web).

```bash
ssh proxy-server -N -D 15000
docker run -e SOCKS_HOST=localhost SOCKS_PORT=15000 ...
```

**Install uBlock Origin adblocker or any other browser extension**

```bash
wget https://github.com/gorhill/uBlock/releases/download/1.41.8/uBlock0_1.41.8.chromium.zip
unzip uBlock0_1.41.8.chromium.zip
docker run -e CHROME_FLAGS="--disable-extensions-except=/ext/ublock --load-extension=/ext/ublock" -v $PWD/uBlock0.chromium:/ext/ublock ...
```

You can also directly use extensions from an existing chrome-profile by using e.g. `~/.config/chromium/Default/Extensions/cjpalhdlnbpafiamejdnhcphjbkeiagm/1.41.8_0/` as the path.


## Saving Crawl State: Interrupting and Restarting the Crawl

With version 0.5.0, a crawl can be gracefully interrupted with Ctrl-C (SIGINT) or a SIGTERM.
When a crawl is interrupted, the current crawl state is written to the `crawls` subdirectory inside the collection directory.
The crawl state includes the current YAML config, if any, plus the current state of the crawl.

The idea is that this crawl state YAML file can then be used as `--config` option to restart the crawl from where it was left of previously.

By default, the crawl interruption waits for current pages to finish. A subsequent SIGINT will cause the crawl to stop immediately. Any unfinished pages
are recorded in the `pending` section of the crawl state (if gracefully finished, the section will be empty).

By default, the crawl state is only written when a crawl is only partially done - when it is interrupted. The `--saveState` cli option can be set to `always`
or `never` respectively, to control when the crawl state file should be written.

### Periodic State Saving

When the `--saveState` is set to always, Browsertrix Crawler will also save the state automatically during the crawl, as set by the `--saveStateInterval` setting.
When The crawler will keep the last `--saveStateHistory` save states and delete older ones. This provides extra backup, in case the crawl fails unexpectedly, or is not terminated via Ctrl-C, several previous crawl states are still available.


## Creating and Using Browser Profiles

Browsertrix Crawler also includes a way to use existing browser profiles when running a crawl. This allows pre-configuring the browser, such as by logging in
to certain sites or setting other settings, and running a crawl exactly with those settings. By creating a logged in profile, the actual login credentials are not included in the crawl, only (temporary) session cookies.


### Interactive Profile Creation

For creating profiles of more complex sites, or logging in to multiple sites at once, the interactive profile creation mode can be used.
To use this mode, don't specify --username or --password flags and expose two ports on the Docker container to allow DevTools to connect to the browser and to serve
a status page.

In profile creation mode, Browsertrix Crawler launches a browser which uses VNC (via noVNC) server running on port 6080 to provide a 'remote desktop' for interacting with the browser.

After interactively logging into desired sites or configuring other settings, the 'Create Profile' should be clicked to initiate profile creation.
Browsertrix Crawler will then stop the browser, and save the browser profile.

For example, to start in interactive profile creation mode, run:

```
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles/ -it webrecorder/browsertrix-crawler create-login-profile --url "https://example.com/"
```

Then, open a browser pointing to `http://localhost:9223/` and use the embedded browser to log in to any sites or configure any settings as needed.
Click 'Create Profile at the top when done. The profile will then be created in `./crawls/profiles/profile.tar.gz` containing the settings of this browsing session.

It is also possible to extend an existing profiles by also passing in an existing profile via the `--profile` flag. In this way, it is possible to build new profiles by extending previous browsing sessions as needed.

```
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles -it webrecorder/browsertrix-crawler create-login-profile --url "https://example.com/ --filename /crawls/profiles/newProfile.tar.gz --profile /crawls/profiles/oldProfile.tar.gz"
```

#### Headless vs Headful Profiles

Browsertrix Crawler supports both 'headful' and headless crawling. We recommend using headful crawling to be most accurate to user experience, however,
headless crawling may be faster.

To use profiles in headless mode, profiles should also be created with `--headless` flag.

When creating browser profile in headless mode, Browsertrix will use the devtools protocol on port 9222 to stream the browser interface (previously, this was also used
in headful mode as well).

To create a profile in headless mode, run:

```
docker run -p 9222:9222 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles/ -it webrecorder/browsertrix-crawler create-login-profile --headless --url "https://example.com/"
```

### Automated Profile Creation for User Login

If the `--automated` flag is provided, Browsertrix Crawler will attempt to create a profile automatically after logging in to sites with a username and password.
The username and password can be provided via `--username` and `--password` flags or, if omitted, from a command-line prompt.

When using `--automated` or `--username` / `--password`, Browsertrix Crawler will not launch an interactive browser and instead will attempt to finish automatically.

The automated profile creation system will log in to a single website with supplied credentials and then save the profile
The script profile creation system also take a screenshot so you can check if the login succeeded.

For example, to launch a browser, and login to the digipres.club Mastodon instance, run:

```bash
docker run -v $PWD/crawls/profiles:/crawls/profiles -it webrecorder/browsertrix-crawler create-login-profile --url "https://digipres.club/"
```

The script will then prompt you for login credentials, attempt to login and create a tar.gz file in `./crawls/profiles/profile.tar.gz`.

- The `--url` parameter should specify the URL of a login page.

- To specify a custom filename, pass along `--filename` parameter.

- To specify the username and password on the command line (for automated profile creation), pass a `--username` and `--password` flags.

- To specify headless mode, add the `--headless` flag. Note that for crawls run with `--headless` flag, it is recommended to also create the profile with `--headless` to ensure the profile is compatible.

- To specify the window size for the profile creation embedded browser, specify `--windowSize WIDTH,HEIGHT`. (The default is 1600x900)


The current profile creation script is still experimental and the script attempts to detect the username and password fields on a site as generically as possible, but may not work for all sites. Additional automated profile creation functionality, such as support for custom profile creation scripts, may be added in the future.

### Using Browser Profile with a Crawl

To use a previously created profile with a crawl, use the `--profile` flag or `profile` option. The `--profile` flag can then be used to specify any Chrome profile stored as a tarball. Using profiles created with same or older version of Browsertrix Crawler is recommended to ensure compatibility. This option allows running a crawl with the browser already pre-configured, logged in to certain sites, language settings configured, etc...

After running the above command, you can now run a crawl with the profile, as follows:

```bash

docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --profile /crawls/profiles/profile.tar.gz --url https://digipres.club/ --generateWACZ --collection test-with-profile
```

Profiles can also be loaded from an http/https URL, eg. `--profile https://example.com/path/to/profile.tar.gz`

## Published Releases / Production Use

When using Browsertrix Crawler in production, it is recommended to use a specific, published version of the image, eg. `webrecorder/browsertrix-crawler:[VERSION]` instead of `webrecorder/browsertrix-crawler` where `[VERSION]` corresponds to one of the published release tag.

All released Docker Images are available from Docker Hub, listed by release tag here: https://hub.docker.com/r/webrecorder/browsertrix-crawler/tags?page=1&ordering=last_updated

Details for each corresponding release tag are also available on GitHub at: https://github.com/webrecorder/browsertrix-crawler/releases


## Architecture

The Docker container provided here packages up several components used in Browsertrix.

The system uses `pywb` in recording mode for capturing the content. The crawl produces a single pywb collection, at `/crawls/collections/<collection name>` in the Docker container.

To access the contents of the crawl, the `/crawls` directory in the container should be mounted to a volume (default in the Docker Compose setup).


### Usage with Docker Compose

Many examples in this README demonstrate running Browsertrix Crawler with `docker run`.

Docker Compose is recommended for building the image and for simple configurations.

For example, to build the latest image, simply run:

```
docker-compose build
```

Docker Compose also simplifies some config options, such as mounting the volume for the crawls.

For example, the following command starts a crawl with 2 workers and generates the CDX.

```
docker-compose run crawler crawl --url https://webrecorder.net/ --generateCDX --collection wr-net --workers 2
```

In this example, the crawl data is written to `./crawls/collections/wr-net` by default.


While the crawl is running, the status of the crawl prints the progress to the JSON log output. This can be disabled by using the `--logging` option and not including `stats`.


### Multi-Platform Build / Support for Apple Silicon (M1/M2)

Browsertrix Crawler uses a browser image which supports amd64 and arm64.

This means Browsertrix Crawler can be built natively on Apple Silicon systems using the default settings. Simply running `docker-compose build` on an Apple Silicon should build a native version that should work for development.

On an Apple Silicon system, the browser used will be Chromium instead of Chrome since there is no Linux build of Chrome for ARM, and this now is handled automatically as part of the build. Note that Chromium is different than Chrome, and for example, some video codecs may not be supported in the ARM / Chromium-based version that would be in the amd64 / Chrome version. For production crawling, it is recommended to run on an amd64 Linux environment.


### Modifying Browser Image

It is also possible to build Browsertrix Crawler with a different browser image. Currently, browser images using Chrome/Chromium (depending on host system chip architecture) and Brave Browser are supported via [browsertrix-browser-base](https://github.com/webrecorder/browsertrix-browser-base).

The browser base image used is specified and can be changed at the top of the Dockerfile in this repo.

Custom browser images can be used by forking [browsertrix-browser-base](https://github.com/webrecorder/browsertrix-browser-base), locally building or publishing an image, and then modifying the Dockerfile in this repo to build from that image.


### Viewing crawled data with pywb

When a crawler is done, another browsertrix-crawler image can be started with a local [pywb](https://github.com/webrecorder/pywb) instance to view crawl:

```
docker run -it -v $(pwd)/crawls:/crawls -p 8080:8080 webrecorder/browsertrix-crawler pywb
```

Then, loading the `http://localhost:8080/wr-net/https://webrecorder.net/` should load a recent crawl of the `https://webrecorder.net/` site.

(Previewing crawl results while a crawl its still running should also be possible soon!)


Support
-------

Initial support for development of Browsertrix Crawler, was provided by [Kiwix](https://kiwix.org/). The initial functionality for Browsertrix Crawler was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between. Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.

Additional support for Browsertrix Crawler, including for the development of the 0.4.x version has been provided by [Portico](https://www.portico.org/).


License
-------

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see
[LICENSE](LICENSE) for more details.
