# YAML Crawl Config

Browsertix Crawler supports the use of a YAML file to set parameters for a crawl. This can be used by passing a valid yaml file to the `--config` option.

The YAML file can contain the same parameters as the command-line arguments. If a parameter is set on the command-line and in the YAML file, the value from the command-line will be used. For example, the following should start a crawl with config in `crawl-config.yaml`.

```sh
docker run -v $PWD/crawl-config.yaml:/app/crawl-config.yaml -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --config /app/crawl-config.yaml
```

The config can also be passed via stdin, which can simplify the command. Note that this require running `docker run` with the `-i` flag. To read config from stdin, pass `--config stdin`

```sh
cat ./crawl-config.yaml | docker run -i -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --config stdin
```

An example config file (eg. crawl-config.yaml) might contain:

```yaml
seeds:
  - https://example.com/
  - https://www.iana.org/

combineWARC: true
```

The list of seeds can be loaded via an external file by specifying the filename via the `seedFile` config or command-line option.

## Seed File

The URL seed file should be a text file formatted so that each line of the file is a url string. An example file is available in the Github repository's fixture folder as [urlSeedFile.txt](https://github.com/webrecorder/browsertrix-crawler/blob/main/tests/fixtures/urlSeedFile.txt).

The seed file must be passed as a volume to the docker container. Your Docker command should be formatted similar to the following:

```sh
docker run -v $PWD/seedFile.txt:/app/seedFile.txt -v $PWD/crawls:/crawls/ webrecorder/browsertrix-crawler crawl --seedFile /app/seedFile.txt
```

## Per-Seed Settings

Certain settings such as scope type, scope includes and excludes, and depth can also be configured per-seed directly in the YAML file, for example:

```yaml
seeds:
  - url: https://webrecorder.net/
    depth: 1
    scopeType: "prefix"
```

## HTTP Auth

Browsertrix Crawler supports HTTP Basic Auth, which can be provide on a per-seed basis as part of the URL, for example:
`--url https://username:password@example.com/`.

Alternatively, credentials can be added to the `auth` field for each seed:

```yaml
seeds:
  - url: https://example.com/
    auth: username:password
```
