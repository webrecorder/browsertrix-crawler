# Browsertrix Crawler

Browsertrix Crawler is a simplified (Chrome)  browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer) to control one or more browsers in parallel.

## Features

Thus far, Browsertrix Crawler supports:

- Single-container, browser based crawling with multiple headless/headful browsers.
- Support for custom browser behaviors, using [Browsertix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) including autoscroll, video autoplay and site-specific behaviors.
- YAML-based configuration, passed via file or via stdin.
- Seed lists and per-seed scoping rules.
- URL blocking rules to block capture of specific URLs (including by iframe URL and/or by iframe contents).
- Screencasting: Ability to watch crawling in real-time (experimental).
- Optimized (non-browser) capture of non-HTML resources.
- Extensible Puppeteer driver script for customizing behavior per crawl or page.
- Ability to create and reuse browser profiles with user/password login or via interactive login through an embedded browser.
- Multi-platform support -- prebuilt Docker images available for Intel/AMD and Apple (M1) CPUs.

## Getting Started

Browsertrix Crawler requires [Docker](https://docs.docker.com/get-docker/) to be installed on the machine running the crawl.

Assuming Docker is installed, you can run a crawl and test your archive with the following steps.

You don't even need to clone this repo, just choose a directory where you'd like the crawl data to be placed, and then run
the following commands. Replace `[URL]` with the web site you'd like to crawl.

1. Run `docker pull webrecorder/browsertrix-crawler`
2. `docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --url [URL] --generateWACZ --text --collection test`
3. The crawl will now run and progress of the crawl will be output to the console. Depending on the size of the site, this may take a bit!
4. Once the crawl is finished, a WACZ file will be created in `crawls/collection/test/test.wacz` from the directory you ran the crawl!
5. You can go to [ReplayWeb.page](https://replayweb.page) and open the generated WACZ file and browse your newly crawled archive!

Here's how you can use some of the command-line options to configure the crawl:

- To include automated text extraction for full text search, add the `--text` flag.

- To limit the crawl to a maximum number of pages, add `--limit P` where P is the number of pages that will be crawled.

- To run more than one browser worker and crawl in parallel, and `--workers N` where N is number of browsers to run in parallel. More browsers will require more CPU and network bandwidth, and does not guarantee faster crawling.

- To crawl into a new directory, specify a different name for the `--collection` param, or, if omitted, a new collection directory based on current time will be created.

Browsertrix Crawler includes a number of additional command-line options, explained below.

## Crawling Configuration Options


<details>
      <summary><b>The Browsertrix Crawler docker image currently accepts the following parameters:</b></summary>

```
      --help                                Show help                  [boolean]
      --version                             Show version number        [boolean]
      --seeds, --url                        The URL to start crawling from
                                                           [array] [default: []]
      --seedFile, --urlFile                 If set, read a list of seed urls,
                                            one per line, from the specified
                                                                        [string]
  -w, --workers                             The number of workers to run in
                                            parallel       [number] [default: 1]
      --crawlId, --id                       A user provided ID for this crawl or
                                            crawl configuration (can also be set
                                            via CRAWL_ID env var)
                                              [string] [default: "4dd1535f7800"]
      --newContext                          The context for each new capture,
                                            can be a new: page, window, session
                                            or browser.
                                                      [string] [default: "page"]
      --waitUntil                           Puppeteer page.goto() condition to
                                            wait for before continuing, can be
                                            multiple separate by ','
                                                  [default: "load,networkidle2"]
      --depth                               The depth of the crawl for all seeds
                                                          [number] [default: -1]
      --limit                               Limit crawl to this number of pages
                                                           [number] [default: 0]
      --timeout                             Timeout for each page to load (in
                                            seconds)      [number] [default: 90]
      --scopeType                           A predfined scope of the crawl. For
                                            more customization, use 'custom' and
                                            set scopeIncludeRx regexes
       [string] [choices: "page", "page-spa", "prefix", "host", "domain", "any", "custom"]
      --scopeIncludeRx, --include           Regex of page URLs that should be
                                            included in the crawl (defaults to
                                            the immediate directory of URL)
      --scopeExcludeRx, --exclude           Regex of page URLs that should be
                                            excluded from the crawl.
      --allowHashUrls                       Allow Hashtag URLs, useful for
                                            single-page-application crawling or
                                            when different hashtags load dynamic
                                            content
      --blockRules                          Additional rules for blocking
                                            certain URLs from being loaded, by
                                            URL regex and optionally via text
                                            match in an iframe
                                                           [array] [default: []]
      --blockMessage                        If specified, when a URL is blocked,
                                            a record with this error message is
                                            added instead               [string]
  -c, --collection                          Collection name to crawl to (replay
                                            will be accessible under this name
                                            in pywb preview)
                               [string] [default: "capture-YYYY-MM-DDThh:mm:ss"]
      --headless                            Run in headless mode, otherwise
                                            start xvfb[boolean] [default: false]
      --driver                              JS driver for the crawler
                                     [string] [default: "/app/defaultDriver.js"]
      --generateCDX, --generatecdx,         If set, generate index (CDXJ) for
      --generateCdx                         use with pywb after crawl is done
                                                      [boolean] [default: false]
      --combineWARC, --combinewarc,         If set, combine the warcs
      --combineWarc                                   [boolean] [default: false]
      --rolloverSize                        If set, declare the rollover size
                                                  [number] [default: 1000000000]
      --generateWACZ, --generatewacz,       If set, generate wacz
      --generateWacz                                  [boolean] [default: false]
      --logging                             Logging options for crawler, can
                                            include: stats, pywb, behaviors,
                                            behaviors-debug
                                                     [string] [default: "stats"]
      --text                                If set, extract text to the
                                            pages.jsonl file
                                                      [boolean] [default: false]
      --cwd                                 Crawl working directory for captures
                                            (pywb root). If not set, defaults to
                                            process.cwd()
                                                   [string] [default: "/crawls"]
      --mobileDevice                        Emulate mobile device by name from:
                                            https://github.com/puppeteer/puppete
                                            er/blob/main/src/common/DeviceDescri
                                            ptors.ts                    [string]
      --userAgent                           Override user-agent with specified
                                            string                      [string]
      --userAgentSuffix                     Append suffix to existing browser
                                            user-agent (ex: +MyCrawler,
                                            info@example.com)           [string]
      --useSitemap, --sitemap               If enabled, check for sitemaps at
                                            /sitemap.xml, or custom URL if URL
                                            is specified
      --statsFilename                       If set, output stats as JSON to this
                                            file. (Relative filename resolves to
                                            crawl working directory)
      --behaviors                           Which background behaviors to enable
                                            on each page
                           [string] [default: "autoplay,autofetch,siteSpecific"]
      --behaviorTimeout                     If >0, timeout (in seconds) for
                                            in-page behavior will run on each
                                            page. If 0, a behavior can run until
                                            finish.       [number] [default: 90]
      --profile                             Path to tar.gz file which will be
                                            extracted and used as the browser
                                            profile                     [string]
      --screencastPort                      If set to a non-zero value, starts
                                            an HTTP server with screencast
                                            accessible on this port
                                                           [number] [default: 0]
      --warcInfo, --warcinfo                Optional fields added to the
                                            warcinfo record in combined WARCs
      --redisStoreUrl                       If set, url for remote redis server
                                            to store state. Otherwise, using
                                            in-memory store             [string]
      --saveState                           If the crawl state should be
                                            serialized to the crawls/ directory.
                                            Defaults to 'partial', only saved
                                            when crawl is interrupted
           [string] [choices: "never", "partial", "always"] [default: "partial"]
      --config                              Path to YAML config file
```
</details>


### Waiting for Page Load

One of the key nuances of browser-based crawling is determining when a page is finished loading. This can be configured with the `--waitUntil` flag.

The default is `load,networkidle2`, which waits until page load and <=2 requests remain, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example). The `--waitUntil networkidle0` may make sense for sites, where absolutely all requests must be waited until before proceeding.

See [page.goto waitUntil options](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options) for more info on the options that can be used with this flag from the Puppeteer docs.


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

combineWARCs: true
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

Browsertrix Crawler also supports automatically running customized in-browser behaviors. The behaviors auto-play videos (when possible),
and auto-fetch content that is not loaded by default, and also run custom behaviors on certain sites.

Behaviors to run can be specified via a comma-separated list passed to the `--behaviors` option. By default, the auto-scroll behavior is not enabled by default, as it may slow down crawling. To enable this behaviors, you can add
`--behaviors autoscroll` or to enable all behaviors, add `--behaviors autoscroll,autoplay,autofetch,siteSpecific`.

The site-specific behavior (or autoscroll) will start running after the page is finished its initial load (as defined by the `--waitUntil` settings). The behavior will then run until finished or until the behavior timeout is exceeded. This timeout can be set (in seconds) via the `--behaviorTimeout` flag (90 seconds by default). Setting the timeout to 0 will allow the behavior to run until it is finished.

See [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for more info on all of the currently available behaviors.


### Watching the crawl -- Screencasting

With version 0.4.0, Browsertrix Crawler includes an experimental 'screencasting' option, which allows watching the crawl in real-time via screencast (connected via a websocket).

To enable, add `--screencastPort` command-line option and also map the port on the docker container. An example command might be:

```
docker run -p 9037:9037 -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl  --url https://www.example.com --screencastPort 9037
```

Then, you can open `http://localhost:9037/` and watch the crawl.

Note: If specifying multiple workers, the crawler should additional be instructed to open each one in a new window, otherwise the screencasting can only update one page at a time.

For example,

```
docker run -p 9037:9037 -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --url https://www.example.com --screencastPort 9037 --newContext window --workers 3
```

will start a crawl with 3 workers, and show the screen of each of the workers from `http://localhost:9037/`.

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

### Configuring chromium / puppeteer / pywb

There is a few environment variables you can set to configure chromium and pywb:

- CHROME_FLAGS will be split by spaces and passed to chromium (via `args` in puppeteer). Note that setting some options is not supported such as `--proxy-server` since they are set by browsertrix itself.
- SOCKS_HOST and SOCKS_PORT are read by pywb0 to proxy upstream traffic

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

Browsertrix Crawler includes a script to login to a single website with supplied credentials and then save the profile, as well as a new 'interactive' profile creation mode.
The script profile creation system also take a screenshot so you can check if the login succeeded. The `--url` parameter should specify the URL of a login page.

For example, to create a profile logged in to Twitter, you can run:

```bash
docker run -v $PWD/crawls/profiles:/output/ -it webrecorder/browsertrix-crawler create-login-profile --url "https://twitter.com/login"
```

The script will then prompt you for login credentials, attempt to login and create a tar.gz file in `./crawls/profiles/profile.tar.gz`.

- To specify a custom filename, pass along `--filename` parameter.

- To specify the username and password on the command line (for automated profile creation), pass a `--username` and `--password` flags.

- To specify headless mode, add the `--headless` flag. Note that for crawls run with `--headless` flag, it is recommended to also create the profile with `--headless` to ensure the profile is compatible.

- To specify the window size for the profile creation embedded browser, specify `--windowSize WIDTH,HEIGHT`. (The default is 1600x900)


The current profile creation script is still experimental and the script attempts to detect the username and password fields on a site as generically as possible, but may not work for all sites. Additional profile functionality, such as support for custom profile creation scripts, may be added in the future.


### Interactive Profile Creation

For creating profiles of more complex sites, or logging in to multiple sites at once, the interactive profile creation mode can be used.
To use this mode, specify the `--interactive` flag and expose two ports on the Docker container to allow DevTools to connect to the browser and to serve
a status page.

In this mode, Browsertrix launches a browser connected to DevTools, and allowing the user to use the browser via the devtools device UI.

After interactively logging into desired sites or configuring other settings, the 'Create Profile' should be clicked to initiate profile creation.

Browsertrix Crawler will then create a profile as before using the current state of the browser and disconnect from devtools.

For example, to start in interactive profile creation mode, run:

```
docker run -p 9222:9222 -p 9223:9223 -v $PWD/crawls/profiles:/output/ -it webrecorder/browsertrix-crawler create-login-profile --interactive --url "https://example.com/"
```

Then, open a browser pointing to `http://localhost:9223/` and use the embedded browser to log in to any sites or configure any settings as needed.
Click 'Create Profile at the top when done. The profile will then be created in `./crawls/profiles/profile.tar.gz` containing the settings of this browsing session.

It is also possible to extend an existing profiles by also passing in an existing profile via the `--profile` flag. In this way, it is possible to build new profiles by extending previous browsing sessions as needed.

```
docker run -p 9222:9222 -p 9223:9223 -v $PWD/crawls/profiles:/profiles --filename /profiles/newProfile.tar.gz -it webrecorder/browsertrix-crawler create-login-profile --interactive --url "https://example.com/ --profile /profiles/oldProfile.tar.gz"
```

### Using Browser Profile with a Crawl

To use a previously created profile with a crawl, use the `--profile` flag or `profile` option. The `--profile` flag can then be used to specify any Chrome profile stored as a tarball. Using profiles created with same or older version of Browsertrix Crawler is recommended to ensure compatibility. This option allows running a crawl with the browser already pre-configured, logged in to certain sites, language settings configured, etc...

After running the above command, you can now run a crawl with the profile, as follows:

```bash

docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --profile /crawls/profiles/profile.tar.gz --url https://twitter.com/ --generateWACZ --collection test-with-profile
```

Profiles can also be loaded from an http/https URL, eg. `--profile https://example.com/path/to/profile.tar.gz`

## Published Releases / Production Use

When using Browsertrix Crawler in production, it is recommended to use a specific, published version of the image, eg. `webrecorder/browsertrix-crawler:[VERSION]` instead of `webrecorder/browsertrix-crawler` where `[VERSION]` corresponds to one of the published release tag.

All released Docker Images are available from Docker Hub, listed by release tag here: https://hub.docker.com/r/webrecorder/browsertrix-crawler/tags?page=1&ordering=last_updated

Details for each corresponding release tag are also available on GitHub at: https://github.com/webrecorder/browsertrix-crawler/releases


## Architecture

The Docker container provided here packages up several components used in Browsertrix.

The system uses:
 - `oldwebtoday/chrome` or `oldwebtoday/chromium` - to install a recent version of Chrome (currently chrome:90) or Chromium (see below).
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/crawls/collections/<collection name>` in the Docker container.

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


While the crawl is running, the status of the crawl (provide by puppeteer-cluster monitoring) prints the progress to the Docker log.


### Multi-Platform Build / Support for Apple M1

Browsertrix Crawler uses a browser image which supports amd64 and arm64 (currently `oldwebtoday/chrome:91`).

This means Browsertrix Crawler can be built natively on Apple M1 systems using the default settings. Simply running `docker-compose build` on an Apple M1 should build a native version that should work for development.

On M1 system, the browser used will be Chromium instead of Chrome since there is no Linux build of Chrome for ARM, and this now is handled automatically as part of the build. Note that Chromium is different than Chrome, and for example, some video codecs may not be supported in the ARM / Chromium-based version that would be in the amd64 / Chrome version. For production crawling, it is recommended to run on an amd64 Linux environment.


### Custom Browser Image

It is also possible to build Browsertrix Crawler with a different browser image. Currently, browser images from `oldwebtoday/chrome` and `oldwebtoday/chromium` are supported.

For example, Webrecorder provides the `oldwebtoday/chromium:91-arm` for running Browsertrix Crawler on ARM-based systems.

To build with this specific Chromium image on an Apple M1 machine, run:

```
docker-compose build --build-arg BROWSER_IMAGE_BASE=oldwebtoday/chromium --build-arg "BROWSER_VERSION=91-arm" --build-arg BROWSER_BIN=chromium-browser
```

The build arguments specify the base image, version and browser binary. This approach can also be used to install a different browser in general from any Debian-based Docker image. Additional browser images may be added in the future.

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
