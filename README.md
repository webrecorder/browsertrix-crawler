# Browsertrix Crawler

Browsertrix Crwaler is a simplified browser-based high-fidelity crawling system, designed to run a single crawl in a single Docker container.

It is designed as part of a more streamlined replacement of the original [Browsertrix](https://github.com/webrecorder/browsertrix).

The original Browsertrix may be too complex for situations where a single crawl is needed, and requires managing multiple containers.

This is an attempt to refactor Browsertrix into a core crawling system, driven by [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer)

The Docker container provided here packages up several components used in Browsertrix.

The system uses:
 - `oldwebtoday/chrome` - to install a recent version of Chrome (currently chrome:84)
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/output/collections/<collection name>`.

The collection can be mounted as a Docker volume and then accessed in pywb.


## Crawling Parameters

The image currently accepts the following parameters:

```
browsertrix-crawler [options]

Options:
      --help         Show help                                         [boolean]
      --version      Show version number                               [boolean]
  -u, --url          The URL to start crawling from          [string] [required]
  -w, --workers      The number of workers to run in parallel
                                                           [number] [default: 1]
      --newContext   The context for each new capture, can be a new: page,
                     session or browser.              [string] [default: "page"]
      --waitUntil    Puppeteer page.goto() condition to wait for before
                     continuing                                [default: "load"]
      --limit        Limit crawl to this number of pages   [number] [default: 0]
      --timeout      Timeout for each page to load (in seconds)
                                                          [number] [default: 90]
      --scope        Regex of page URLs that should be included in the crawl
                     (defaults to the immediate directory of URL)
      --exclude      Regex of page URLs that should be excluded from the crawl.
      --scroll       If set, will autoscroll to bottom of the page
                                                      [boolean] [default: false]
  -c, --collection   Collection name to crawl to (replay will be accessible
                     under this name in pywb preview)
                                                   [string] [default: "capture"]
      --headless     Run in headless mode, otherwise start xvfb
                                                      [boolean] [default: false]
      --driver       JS driver for the crawler
     [string] [default: "/Users/ilya/work/browsertrix-crawler/defaultDriver.js"]
      --generateCDX  If set, generate index (CDXJ) for use with pywb after crawl
                     is done                          [boolean] [default: false]
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

While the crawl is running, puppeteer-cluster provides monitoring output which is enabled by default and prints the crawl status to the Docker log.

The output is written to `./crawls/collections/wr-net` by default.

When done, you can even use the browsertrix-crawler image to also start a local [pywb](https://github.com/webrecorder/pywb) instance
to preview the crawl:

```
cd crawls
docker run it -p 8080:8080 webrecorder/browsertrix-crawler pywb
```

Then, loading the `http://localhost:8080/wr-net/https://webrecorder.net/` should load a recent crawl of the `https://webrecorder.net/` site.


#### With `docker run`

Browsertrix Crawler can of course all be run directly with Docker run, but requires a few more options.

In particular, the `--cap-add` and `--shm-size`
flags are [needed to run Chrome in Docker](https://github.com/puppeteer/puppeteer/blob/v1.0.0/docs/troubleshooting.md#tips).


```bash
docker run -v $PWD/crawls:/output --cap-add=SYS_ADMIN --cap-add=NET_ADMIN --shm-size=1g -it webrecorder/browsertrix-crawler --url https://webrecorder.net/ --workers 2

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
