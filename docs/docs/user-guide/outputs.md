# Outputs

This page covers the outputs created by Browsertrix Crawler for both crawls and browser profiles.

## Crawl Outputs

Browsertrix Crawler crawl outputs are organized into collections, which can be found in the `/crawls/collection` directory. Each crawl creates a new collection by default, which can be named with the `-c` or `--collection` argument. If a collection name is not provided, Browsertrix Crawler will generate a unique collection name which includes the `crawl-` prefix followed by a timestamp of when the collection was created. Collections can be overwritten by specifying an existing collection name.

Each collection is a directory which contains at minimum:

- `archive/`: A directory containing gzipped [WARC](https://www.iso.org/standard/68004.html) files containing the web traffic recorded during crawling.
- `logs/`: A directory containing one or more crawler log files in [JSON-Lines](https://jsonlines.org/) format.
- `pages/`: A directory containing one or more "Page" files in [JSON-Lines](https://jsonlines.org/) format. At minimum, this directory will contain a `pages.jsonl` file with information about the seed URLs provided to the crawler. If additional pages were discovered and in scope during crawling, information about those non-seed pages is written to `extraPages.jsonl`. For more information about the contents of Page files, see the [WACZ specification](https://specs.webrecorder.net/wacz/1.1.1/#pages-jsonl).
- `warc-cdx/`: A directory containing one or more [CDXJ](https://specs.webrecorder.net/cdxj/0.1.0/) index files created while recording traffic to WARC files. These index files are 

Additionally, the collection may include:

- A WACZ file named after the collection, if the `--generateWACZ` argument is provided.
- An `indexes/` directory containing merged [CDXJ](https://specs.webrecorder.net/cdxj/0.1.0/) index files for the crawl, if the `--generateCDX` or `--generateWACZ` arguments are provided. If the combined size of the CDXJ files in the `warc-cdx/` directory is over 50 KB, the resulting final CDXJ file will be gzipped.
- A single combined gzipped [WARC](https://www.iso.org/standard/68004.html) file for the crawl, if the `--combineWARC` argument is provided.
- A `crawls/` directory including YAML files describing the crawl state, if the `--saveState` argument is provided with a value of "always", or if the crawl is interrupted and `--saveState` is not set to "never". These files can be used to restart a crawl from its saved state.

## Profile Outputs

Browser profiles that are saved by Browsertrix Crawler are written into the `crawls/profiles` directory.
