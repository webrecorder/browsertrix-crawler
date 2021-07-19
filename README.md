# Browsertrix Crawler

Browsertrix Crawler is a simplified (Chrome)  browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer) to control one or more browsers in parallel.

## Features

Thus far, Browsertrix Crawler supports:

- Single-container, browser based crawling with multiple headless/headful browsers.
- Support for custom browser behaviors, using [Browsertix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) including autoscroll, video autoplay and site-specific behaviors.
- Optimized (non-browser) capture of non-HTML resources.
- Extensible Puppeteer driver script for customizing behavior per crawl or page.
- Ability to create and reuse browser profiles with user/password login

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
      --newContext                          The context for each new capture,
                                            can be a new: page, window, session
                                            or browser.
                                                      [string] [default: "page"]
      --waitUntil                           Puppeteer page.goto() condition to
                                            wait for before continuing, can be
                                            multiple separate by ','
                                                  [default: "load,networkidle0"]
      --depth                               The depth of the crawl for all seeds
                                                          [number] [default: -1]
      --limit                               Limit crawl to this number of pages
                                                           [number] [default: 0]
      --timeout                             Timeout for each page to load (in
                                            seconds)      [number] [default: 90]
      --scopeType                           Predefined for which URLs to crawl,
                                            can be: prefix, page, host, any, or
                                            custom, to use the
                                            scopeIncludeRx/scopeExcludeRx
                                                                        [string]
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
      --profile                             Path to tar.gz file which will be
                                            extracted and used as the browser
                                            profile                     [string]
      --screencastPort                      If set to a non-zero value, starts
                                            an HTTP server with screencast
                                            accessible on this port
                                                           [number] [default: 0]
      --warcInfo, --warcinfo                Optional fields added to the
                                            warcinfo record in combined WARCs
      --config                              Path to YAML config file
```
</details>


For the `--waitUntil` flag,  see [page.goto waitUntil options](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options).

The default is `load`, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example),
while `--waitUntil networkidle0` may make sense for dynamic sites.

### YAML Crawl Config

Browsertix Crawler supports the use of a yaml file to set parameters for a crawl. This can be used by passing a valid yaml file to the `--config` option.

The YAML file can contain the same parameters as the command-line arguments. If a parameter is set on the command-line and in the yaml file, the value from the command-line will be used. For example, the following should start a crawl with config in `crawl-config.yaml` (where [VERSION] represents the version of browsertrix-crawler image you're working with). The current [VERSION] can be found by checking the package.json file.


```
docker run -v $PWD/crawl-config.yaml:/app/crawl-config.yaml -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler:[VERSION] crawl —-config /app/crawl-config.yaml
```

The config can also be passed via stdin, which can simplify the command. Note that this require running `docker run` with the `-i` flag. To read config from stdin, pass `--config stdin`

```
cat ./crawl-config.yaml | docker run -i -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler:[VERSION] crawl —-config stdin
```


An example config file might contain:

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
docker run -v $PWD/seedFile.txt:/app/seedFile.txt -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler:[VERSION] crawl —-seedFile /app/seedFile.txt
```

#### Per-Seed Settings

Certain settings such scope type, scope includes and excludes, and depth can also be configured per seed directly in the YAML file, for example:

```
seeds:
  - url: https://webrecorder.net/
    depth: 1
    type: "prefix"
```

### Scope Types

The crawl scope can be configured globally for all seeds, or customized per seed, by specifying the `--scopeType` command-line option or setting the `type` property for each seed.

The scope controls which linked pages are also included in the crawl.

The available types are:

- `page` - crawl only this page, but load any links that include different hashtags. Useful for single-page apps that may load different content based on hashtag.

- `prefix` - crawl any pages in the same directory, eg. starting from `https://example.com/path/page.html`, crawl anything under `https://example.com/path/` (default)

- `host` - crawl pages that share the same host.

- `any` - crawl any and all pages.

- `none` - don't crawl any additional pages besides the seed.


The `depth` setting also limits how many pages will be crawled for that seed, while the `limit` option sets the total
number of pages crawled from any seed.

### Block Rules

While scope rules define which pages are to be crawled, it is also possible to block certain URLs in certain pages or frames from being recorded.

This is useful for blocking ads or other content that should not be included.

The block rules can be specified as a list in the `blockRules` field. Each rule can contain one of the following fields:

- `url`: regex for URL to match (required)

- `type`: can be `block` or `allowOnly`. The block rule blocks the specified match, while allowOnly inverts the match and allows only the matched URLs, while blocking all others.

- `inFrameUrl`: if specified, indicates that the rule only applies when `url` is loaded in a specific iframe or top-level frame.

- `frameTextMatch`: if specified, the text of the specified URL is checked for the regex, and the rule applies only if there is an additional match. When specified, this field makes the block rule apply only to frame-level resource, eg. URLs loaded directly in an iframe or top-level frame.

For example, a very simple block rule that blocks all URLs from 'googleanalytics.com' can be added with:

```
blockRules:
   - url: googleanalytics.com
```

For additional examples of block rules, see the [tests/blockrules.test.js](tests/blockrules.test.js) file in the test suite.

If the `--blockMessage` is also specified, a blocked URL is replaced with the specified message (added as a WARC resource record).


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

See [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for more info on all of the currently available behaviors.


### Watching the crawl -- Screencasting

With version 0.4.0, Browsertrix Crawler includes an experimental 'screencasting' option, which allows watching the crawl in real-time via screencast (connected via a websocket).

To enable, add `--screencastPort` command-line option and also map the port on the docker container. An example command might be:

```
docker run -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler:[VERSION] crawl -p 9037:9037 --url https://www.example.com --screencastPort 9037
```

Then, you can open `http://localhost:9037/` and watch the crawl.

Note: If specifying multiple workers, the crawler should additional be instructed to open each one in a new window, otherwise the screencasting can only update one page at a time.

For example,

```
docker run -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler:[VERSION] crawl -p 9037:9037 --url https://www.example.com --screencastPort 9037 --newContext window --workers 3
```

will start a crawl with 3 workers, and show the screen of each of the workers from `http://localhost:9037/`.


## Creating and Using Browser Profiles

Browsertrix Crawler also includes a way to use existing browser profiles when running a crawl. This allows pre-configuring the browser, such as by logging in
to certain sites or setting other settings, and running a crawl exactly with those settings. By creating a logged in profile, the actual login credentials are not included in the crawl, only (temporary) session cookies.

Browsertrix Crawler currently includes a script to login to a single website with supplied credentials and then save the profile.
It can also take a screenshot so you can check if the login succeeded. The `--url` parameter should specify the URL of a login page.

For example, to create a profile logged in to Twitter, you can run:

```bash
docker run -v $PWD/crawls/profiles:/output/ -it webrecorder/browsertrix-crawler create-login-profile --url "https://twitter.com/login"
```

The script will then prompt you for login credentials, attempt to login and create a tar.gz file in `./crawls/profiles/profile.tar.gz`.

- To specify a custom filename, pass along `--filename` parameter.

- To specify the username and password on the command line (for automated profile creation), pass a `--username` and `--password` flags.

- To specify headless mode, add the `--headless` flag. Note that for crawls run with `--headless` flag, it is recommended to also create the profile with `--headless` to ensure the profile is compatible.

The `--profile` flag can then be used to specify a Chrome profile stored as a tarball when running the regular `crawl` command. With this option, it is possible to crawl with the browser already pre-configured. To ensure compatibility, the profile should be created using the following mechanism.

After running the above command, you can now run a crawl with the profile, as follows:

```bash

docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --profile /crawls/profiles/profile.tar.gz --url https://twitter.com/--generateWACZ --collection test-with-profile
```

The current profile creation script is still experimental and the script attempts to detect the usename and password fields on a site as generically as possible, but may not work for all sites. Additional profile functionality, such as support for custom profile creation scripts, may be added in the future.


## Architecture

The Docker container provided here packages up several components used in Browsertrix.

The system uses:
 - `oldwebtoday/chrome` or `oldwebtoday/chromium` - to install a recent version of Chrome (currently chrome:90) or Chromium (see below).
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/crawls/collections/<collection name>` in the Docker container.

To access the contents of the crawl, the `/crawls` directory in the container should be mounted to a volume (default in the Docker Compose setup).

### Building with Custom Browser Image / Building on Apple M1

Browsertrix Crawler can be built on the new ARM M1 chip (for development). However, since there is no Linux build of Chrome for ARM, Chromium can be used instead. Currently, Webrecorder provides the `oldwebtoday/chromium:91-arm` for running Browsertrix Crawler on ARM-based systems.

For example, to build with this Chromium image on an Apple M1 machine, run:

```
docker-compose build --build-arg BROWSER_IMAGE_BASE=oldwebtoday/chromium --build-arg "BROWSER_VERSION=91-arm" --build-arg BROWSER_BIN=chromium-browser
```

You should then be able to run Browsertrix Crawler natively on M1.

The build arguments specify the base image, version and browser binary. This approach can also be used to install a different browser in general from any Debian-based Docker image.


### Example Usage


#### With Docker-Compose

The Docker Compose file can simplify building and running a crawl, and includes some required settings for `docker run`, including mounting a volume.

For example, the following commands demonstrate building the image, running a simple crawl with 2 workers:

```
docker-compose build
docker-compose run crawler crawl --url https://webrecorder.net/ --generateCDX --collection wr-net --workers 2
```

In this example, the crawl data is written to `./crawls/collections/wr-net` by default.

While the crawl is running, the status of the crawl (provide by puppeteer-cluster monitoring) prints the progress to the Docker log.

When done, you can even use the browsertrix-crawler image to also start a local [pywb](https://github.com/webrecorder/pywb) instance
to preview the crawl:

```
docker run -it -v $(pwd)/crawls:/crawls -p 8080:8080 webrecorder/browsertrix-crawler pywb
```

Then, loading the `http://localhost:8080/wr-net/https://webrecorder.net/` should load a recent crawl of the `https://webrecorder.net/` site.


#### With `docker run`

Browsertrix Crawler can of course all be run directly with Docker run, but requires a few more options.

In particular, the `--cap-add` and `--shm-size`
flags are [needed to run Chrome in Docker](https://github.com/puppeteer/puppeteer/blob/v1.0.0/docs/troubleshooting.md#tips).


```bash
docker run -v $PWD/crawls:/crawls --cap-add=SYS_ADMIN --cap-add=NET_ADMIN --shm-size=1g -it webrecorder/browsertrix-crawler --url https://webrecorder.net/ --workers 2

```


Support
-------

Initial support for development of Browsertrix Crawler, was provided by [Kiwix](https://kiwix.org/)

Initial functionality for Browsertrix Crawler was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between
Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.


License
-------

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see
[LICENSE](LICENSE) for more details.
