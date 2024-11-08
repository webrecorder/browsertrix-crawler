# Browser Behaviors

Browsertrix Crawler supports automatically running customized in-browser behaviors. The behaviors auto-play videos (when possible), auto-fetch content that is not loaded by default, and also run custom behaviors on certain sites.

To run behaviors, specify them via a comma-separated list passed to the `--behaviors` option. All behaviors are enabled by default, the equivalent of `--behaviors autoscroll,autoplay,autofetch,siteSpecific`. To enable only a single behavior, such as autoscroll, use `--behaviors autoscroll`.

The site-specific behavior (or autoscroll) will start running after the page is finished its initial load (as defined by the `--waitUntil` settings). The behavior will then run until finished or until the behavior timeout is exceeded. This timeout can be set (in seconds) via the `--behaviorTimeout` flag (90 seconds by default). Setting the timeout to 0 will allow the behavior to run until it is finished.

See [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for more info on all of the currently available behaviors.

Browsertrix Crawler includes a `--pageExtraDelay`/`--delay` option, which can be used to have the crawler sleep for a configurable number of seconds after behaviors before moving on to the next page.

To disable behaviors for a crawl, use `--behaviors ""`.

## Additional Custom Behaviors

Custom behaviors can be mounted into the crawler and ran from there, or downloaded from a URL.

Each behavior should contain a single class that implements the behavior interface. See [the behaviors tutorial](https://github.com/webrecorder/browsertrix-behaviors/blob/main/docs/TUTORIAL.md) for more info on how to write behaviors.

The first behavior which returns true for `isMatch()` will be run on a given page.

The repeatable `--customBehaviors` flag can accept:

- A path to a directory of behavior files
- A path to a single behavior file
- A URL for a single behavior file to download
- A URL for a git repository of the form `git+https://git.example.com/repo.git`, with optional query parameters `branch` (to specify a particular branch to use) and `path` (to specify a relative path to a directory within the git repository where the custom behaviors are located)

### Examples

#### Local filepath (directory)

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors /custom-behaviors/
```

#### Local filepath (file)

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors /custom-behaviors/custom-behavior-1.js
```

#### URL

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors https://example.com/custom-behavior-1 --customBehaviors https://example.org/custom-behavior-2 
```

#### Git repository

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors "git+https://git.example.com/custom-behaviors?branch=dev&path=path/to/behaviors"
```
