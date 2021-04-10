# Browsertrix Crawler

Browsertrix Crawler is a simplified browser-based high-fidelity crawling system, designed to run a single crawl in a single Docker container. It is designed as  a core component of to replace the the original [Browsertrix](https://github.com/webrecorder/browsertrix) application.

This is an attempt to refactor Browsertrix into a core crawling system, driven by [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer)

## Features

Thus far, Browsertrix Crawler supports:

- Single-container, browser based crawling with multiple headless/headful browsers
- Support for browser behaviors, loaded from [Browsertix Behaviors](https://github.com/webrecorder/browsertrix-behaviors)
- Support for direct capture for non-HTML resources
- Extensible driver script for customizing behavior per crawl or page via Puppeteer
- Ability to create re-useable profiles with user/password login

## Architecture

The Docker container provided here packages up several components used in Browsertrix.

The system uses:
 - `oldwebtoday/chrome` - to install a recent version of Chrome (currently chrome:84)
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/crawls/collections/<collection name>` in the Docker container.

To access the contents of the crawl, the `/crawls` directory in the container should be mounted to a volume (default in the Docker Compose setup).


## Crawling Parameters

The Browsertrix Crawler docker image currently accepts the following parameters:

```
browsertrix-crawler [options]

Options:
      --help                                Show help                  [boolean]
      --version                             Show version number        [boolean]
  -u, --url                                 The URL to start crawling from
                                                             [string] [required]
  -w, --workers                             The number of workers to run in
                                            parallel       [number] [default: 1]
      --newContext                          The context for each new capture,
                                            can be a new: page, session or
                                            browser.  [string] [default: "page"]
      --waitUntil                           Puppeteer page.goto() condition to
                                            wait for before continuing, can be
                                            multiple separate by ','
                                                  [default: "load,networkidle0"]
      --limit                               Limit crawl to this number of pages
                                                           [number] [default: 0]
      --timeout                             Timeout for each page to load (in
                                            seconds)      [number] [default: 90]
      --scope                               Regex of page URLs that should be
                                            included in the crawl (defaults to
                                            the immediate directory of URL)
      --exclude                             Regex of page URLs that should be
                                            excluded from the crawl.
  -c, --collection                          Collection name to crawl to (replay
                                            will be accessible under this name
                                            in pywb preview)
                                [string] [default: "capture-2021-04-10T04-49-4"]
      --headless                            Run in headless mode, otherwise
                                            start xvfb[boolean] [default: false]
      --driver                              JS driver for the crawler
                                     [string] [default: "/app/defaultDriver.js"]
      --generateCDX, --generatecdx,         If set, generate index (CDXJ) for
      --generateCdx                         use with pywb after crawl is done
                                                      [boolean] [default: false]
      --generateWACZ, --generatewacz,       If set, generate wacz
      --generateWacz                                  [boolean] [default: false]
      --logging                             Logging options for crawler, can
                                            include: stats, pywb, behaviors
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
      --useSitemap                          If enabled, check for sitemaps at
                                            /sitemap.xml, or custom URL if URL
                                            is specified
      --statsFilename                       If set, output stats as JSON to this
                                            file. (Relative filename resolves to
                                            crawl working directory)
      --behaviors                           Which background behaviors to enable
                                            on each page
                           [string] [default: "autoplay,autofetch,siteSpecific"]

```

For the `--waitUntil` flag,  see [page.goto waitUntil options](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options).

The default is `load`, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example),
while `--waitUntil networkidle0` may make sense for dynamic sites.

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
