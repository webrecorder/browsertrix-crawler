# Browser Behaviors

Browsertrix Crawler supports automatically running customized in-browser behaviors. The behaviors auto-play videos (when possible), auto-fetch content that is not loaded by default, and also run custom behaviors on certain sites.

To run behaviors, specify them via a comma-separated list passed to the `--behaviors` option. All behaviors are enabled by default, the equivalent of `--behaviors autoscroll,autoplay,autofetch,siteSpecific`. To enable only a single behavior, such as autoscroll, use `--behaviors autoscroll`.

The site-specific behavior (or autoscroll) will start running after the page is finished its initial load (as defined by the `--waitUntil` settings). The behavior will then run until finished or until the behavior timeout is exceeded. This timeout can be set (in seconds) via the `--behaviorTimeout` flag (90 seconds by default). Setting the timeout to 0 will allow the behavior to run until it is finished.

See [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for more info on all of the currently available behaviors.

Browsertrix Crawler includes a `--pageExtraDelay`/`--delay` option, which can be used to have the crawler sleep for a configurable number of seconds after behaviors before moving on to the next page.

## Additional Custom Behaviors

Custom behaviors can be mounted into the crawler and loaded from there. For example:

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors /custom-behaviors/
```

This will load all the custom behaviors stored in the `tests/custom-behaviors` directory. The first behavior which returns true for `isMatch()` will be run on a given page.

Each behavior should contain a single class that implements the behavior interface. See [the behaviors tutorial](https://github.com/webrecorder/browsertrix-behaviors/blob/main/docs/TUTORIAL.md) for more info on how to write behaviors.
