Browsertrix Core
================

Browsertrix Core is a simplified browser-based high-fidliety crawling system, designed to run a single crawl in a single Docker container.

It is designed as part of a more streamlined replacement of the original [Browsertrix](https://github.com/webrecorder/browsertrix).

The original Browsertrix may be too complex for situations where a single crawl is needed, and requires managing multiple containers.

This is an attempt to refactor Browsertrix into a core crawling system, driven by [puppeteer-cluster](https://github.com/thomasdondorf/puppeteer-cluster)
and [puppeteer](https://github.com/puppeteer/puppeteer)

The Docker container provided here packages up several components used in Browsertrix.

The system uses:
 - `oldwebtoday/chrome` - to install a recent version of Chrome (currently chrome:84)
 - `puppeteer-cluster` - for running Chrome browsers in parallel
 - `pywb` - in recording mode for capturing the content


The crawl produces a single pywb collection, at `/output/collections/capture`.

The collection can be mounted as a Docker volume and then accessed in pywb.


Crawling Parameters
-------------------

The image currently accepts the following parameters:

- `--url URL` - the url to be crawled (required)
- `--workers N` - number of crawl workers to be run in parallel
- `--wait-until` - Puppeteer setting for how long to wait for page load. See [page.goto waitUntil options](https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pagegotourl-options). The default is `load`, but for static sites, `--wait-until domcontentloaded` may be used to speed up the crawl (to avoid waiting for ads to load for example).
- `--name` - Name of ZIM file (defaults to the hostname of the URL)
- `--output` - output directory (defaults to `/output`)
- `--limit U` - Limit capture to at most U URLs
- `--exclude <regex>` - skip URLs that match the regex from crawling. Can be specified multiple times.
- `--scroll [N]` - if set, will activate a simple auto-scroll behavior on each page to scroll for upto N seconds


The following is an example usage. The `--cap-add` and `--shm-size`
flags are [needed to run Chrome in Docker](https://github.com/puppeteer/puppeteer/blob/v1.0.0/docs/troubleshooting.md#tips).

Example command:

```bash
docker run -v ./collections/my-crawl:/output/collections/capture --cap-add=SYS_ADMIN --cap-add=NET_ADMIN --shm-size=1g -it webrecorder/browsertrix-crawler --url https://www.iana.org/ --workers 2

```

The puppeteer-cluster provides monitoring output which is enabled by default and prints the crawl status to the Docker log.

With the above example, when the crawl is finished, you can run pywb and browse the collection from: `http://localhost:8080/my-crawl/https://www.iana.org/`


Support
-------

Initial support for development of Browsertrix Core, was provided by [Kiwix](https://kiwix.org/)

Initial functionality for Browsertrix Core was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between
Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.


License
-------

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see
[LICENSE](LICENSE) for more details.
