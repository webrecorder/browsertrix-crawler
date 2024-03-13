# Development

## Usage with Docker Compose

Many examples in User Guide demonstrate running Browsertrix Crawler with `docker run`.

Docker Compose is recommended for building the image and for simple configurations. A simple Docker Compose configuration file is included in the Git repository.

For example, to build the latest image, simply run:

```sh
docker-compose build
```

Docker Compose also simplifies some config options, such as mounting the volume for the crawls.

For example, the following command starts a crawl with 2 workers and generates the CDX.

```sh
docker-compose run crawler crawl --url https://webrecorder.net/ --generateCDX --collection wr-net --workers 2
```

In this example, the crawl data is written to `./crawls/collections/wr-net` by default.

While the crawl is running, the status of the crawl prints the progress to the JSON-L log output. This can be disabled by using the `--logging` option and not including `stats`.

## Multi-Platform Build / Support for Apple Silicon (M1/M2)

Browsertrix Crawler uses a browser image which supports amd64 and arm64.

This means Browsertrix Crawler can be built natively on Apple Silicon systems using the default settings. Simply running `docker-compose build` on an Apple Silicon should build a native version that should work for development.

## Modifying Browser Image

It is also possible to build Browsertrix Crawler with a different browser image. Currently, browser images using Brave Browser and Chrome/Chromium (depending on host system chip architecture are supported via [browsertrix-browser-base](https://github.com/webrecorder/browsertrix-browser-base), however, only Brave Browser is receiving regular version updates.

The browser base image used is specified and can be changed at the top of the Dockerfile in the Browsertrix Crawler repo.

Custom browser images can be used by forking [browsertrix-browser-base](https://github.com/webrecorder/browsertrix-browser-base), locally building or publishing an image, and then modifying the Dockerfile in this repo to build from that image.
