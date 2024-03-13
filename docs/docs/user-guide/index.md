# Browsertrix Crawler User Guide

Welcome to the Browsertrix User Guide. This page covers the basics of using Browsertrix Crawler, Webrecorder's browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container.

## Getting Started

Browsertrix Crawler requires [Docker](https://docs.docker.com/get-docker/) to be installed on the machine running the crawl.

Assuming Docker is installed, you can run a crawl and test your archive with the following steps.

You don't even need to clone the Browsertrix Crawler repo, just choose a directory where you'd like the crawl data to be placed, and then run
the following commands. Replace `[URL]` with the website you'd like to crawl.

1. Run `docker pull webrecorder/browsertrix-crawler`
2. `docker run -v $PWD/crawls:/crawls/ -it webrecorder/browsertrix-crawler crawl --url [URL] --generateWACZ --text --collection test`
3. The crawl will now run and logs in [JSON Lines](https://jsonlines.org/) format will be output to the console. Depending on the size of the site, this may take a bit!
4. Once the crawl is finished, a WACZ file will be created in `crawls/collection/test/test.wacz` from the directory you ran the crawl!
5. You can go to [ReplayWeb.page](https://replayweb.page) and open the generated WACZ file and browse your newly crawled archive!

## Getting Started with Command-Line Options

Here's how you can use some of the more common command-line options to configure the crawl:

- To include automated text extraction for full text search to pages.jsonl, add the `--text` flag. To write extracted text to WARCs instead of or in addition to pages.jsonl, see [Text Extraction](TODO - LINK NEEDED).

- To limit the crawl to a maximum number of pages, add `--limit P` where P is the number of pages that will be crawled.

- To limit the crawl to a maximum size, set `--sizeLimit` (size in bytes).

- To limit the crawl time, set `--timeLimit` (in seconds).

- To run more than one browser worker and crawl in parallel, and `--workers N` where N is number of browsers to run in parallel. More browsers will require more CPU and network bandwidth, and does not guarantee faster crawling.

- To crawl into a new directory, specify a different name for the `--collection` param. If omitted, a new collection directory based on current time will be created. Adding the `--overwrite` flag will delete the collection directory at the start of the crawl, if it exists.

Browsertrix Crawler includes a number of additional command-line options, explained in detail throughout this User Guide.

## Published Releases / Production Use

When using Browsertrix Crawler in production, it is recommended to use a specific, published version of the image, eg. `webrecorder/browsertrix-crawler:[VERSION]` instead of `webrecorder/browsertrix-crawler` where `[VERSION]` corresponds to one of the published release tag.

All released Docker Images are available from [Docker Hub, listed by release tag here](https://hub.docker.com/r/webrecorder/browsertrix-crawler/tags?page=1&ordering=last_updated).

Details for each corresponding release tag are also available on GitHub under [Releases](https://github.com/webrecorder/browsertrix-crawler/releases).
