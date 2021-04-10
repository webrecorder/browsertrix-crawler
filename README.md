# Browsertrix Crawler

Browsertrix Crawler is a simplified (Chrome)  browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer) to control one or more browsers in parallel.

## Features

Thus far, Browsertrix Crawler supports:

- Single-container, browser based crawling with multiple headless/headful browsers.
- Support for custom browser behaviors, ysing [Browsertix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) including autoscroll, video autoplay and site-specific behaviors.
- Optimized (non-browser) capture of non-HTML resources.
- Extensible Puppeteer driver script for customizing behavior per crawl or page.
- Ability to create and reuse browser profiles with user/password login

## Getting Started

Browsertrix Crawler requires [Docker](https://docs.docker.com/get-docker/) to be installed on the machine running the crawl.

Assuming Docker is installed, you can run a crawl and test your archive with the following steps.

You don't even need to clone this repo, just choose a directory where you'd like the crawl data to be placed, and then run
the following commands. Replace `[URL]` with the web site you'd like to crawl.

1. Run `docker pull webrecorder/browsertrix-crawler`
2. `docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --url [URL] --generateWACZ --collection test`
3. The crawl will now run and progress of the crawl will be output to the console. Depending on the size of the site, this may take a bit!
4. Once the crawl is finished, a WACZ file will be created in `crawls/collection/test/test.wacz` from the directory you ran the crawl!
5. You can go to [ReplayWeb.page](https://replayweb.page) and open the generated WACZ file and browse your newly crawled archive!

- To limit the crawl to a maximum number of pages, add `--limit P` where P is the number of pages that will be crawled.
- 
- To run more than one browser worker and crawl in parallel, and `--workers N` where N is number of browsers to run in parallel. More browsers will require more CPU and network bandwidth, and does not guarantee faster crawling.

- To crawl into a new directory, specify a different name for the `--collection` param, or, if omitted, a new collection directory based on current time will be created.

Browsertrix Crawler includes a number of parameters and crawling options, explained further below.

## Crawling Configuration Options

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
      --profile                             Path to tar.gz file which will be
                                            extracted and used as the browser
                                            profile                     [string]
```

For the `--waitUntil` flag,  see [page.goto waitUntil options](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options).

The default is `load`, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example),
while `--waitUntil networkidle0` may make sense for dynamic sites.


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
 - `oldwebtoday/chrome` - to install a recent version of Chrome (currently chrome:84)
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/crawls/collections/<collection name>` in the Docker container.

To access the contents of the crawl, the `/crawls` directory in the container should be mounted to a volume (default in the Docker Compose setup).



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
