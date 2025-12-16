# Browser Behaviors

Browsertrix Crawler supports automatically running customized behaviors on each page. Several types of behaviors are supported, including built-in, background, and site-specific behaviors. It is also possible to add fully user-defined custom behaviors that can be added to trigger specific actions on certain pages.

## Built-In Behaviors

The built-in behaviors include the following background behaviors which run 'in the background' continually checking for changes:
 
- Autoplay: find and start playing (when possible) any video or audio on the page (and in each iframe).
- Autofetch: find and start fetching any URLs that may not be fetched by default, such as other resolutions in `img` tags, `data-*`, lazy-loaded resources, etc.
- Autoclick: select all tags (default: `a` tag, customizable via `--clickSelector`) that may be clickable and attempt to click them while avoiding navigation away from the page.

There is also a built-in 'main' behavior, which runs to completion (or until a timeout is reached):

- Autoscroll: Determine if a page might need scrolling, and scroll either up or down while new elements are being added. Continue until timeout is reached or scrolling is no longer possible.

## Site-Specific Behaviors

Browsertrix also comes with several 'site-specific' behaviors, which run only on specific sites. These behaviors will run instead of Autoscroll and will run until completion or timeout. Currently, site-specific behaviors include major social media sites.

Refer to [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for the latest list of site-specific behaviors.

User-defined custom behaviors are also considered site-specific.
 
## Enabling Behaviors

To enable built-in behaviors, specify them via a comma-separated list passed to the `--behaviors` option. All behaviors except Autoclick are enabled by default, the equivalent of `--behaviors autoscroll,autoplay,autofetch,siteSpecific`. To enable only a single behavior, such as Autoscroll, use `--behaviors autoscroll`.

To only use Autoclick but not Autoscroll, use `--behaviors autoclick,autoplay,autofetch,siteSpecific`.

The `--siteSpecific` flag enables all site-specific behaviors to be enabled, but only one behavior can be run per site. Each site-specific behavior specifies which site it should run on.

To disable all behaviors, use `--behaviors ""`.

## Behavior and Page Timeouts

Browsertrix includes a number of timeouts, including before, during and after running behaviors.

The timeouts are as follows:

- `--pageLoadTimeout`: how long to wait for page to finish loading, *before* doing anything else.
- `--postLoadDelay`: how long to wait *before* starting any behaviors, but after page has finished loading. A custom behavior can override this (see below).
- `--behaviorTimeout`: maximum time to spend on running site-specific / Autoscroll behaviors (can be less if behavior finishes early).
- `--pageExtraDelay`: how long to wait *after* finishing behaviors (or after `behaviorTimeout` has been reached) before moving on to next page.

A site-specific behavior (or Autoscroll) will start after the page is loaded (at most after `--pageLoadTimeout` seconds) and exactly after `--postLoadDelay` seconds.

The behavior will then run until finished or at most until `--behaviorTimeout` is reached (90 seconds by default).

## Loading Custom Behaviors

Browsertrix Crawler also supports fully user-defined behaviors, which have all the capabilities of the built-in behaviors.

They can use a library of provided functions, and run on one or more pages in the crawl.

Custom behaviors are specified with the `--customBehaviors` flag, which can be repeated and can accept the following options.

- A path to a single behavior file. This can be mounted into the crawler as a volume.
- A path to a directory of behavior files. This can be mounted into the crawler as a volume.
- A URL for a single behavior file to download. This should be a URL that the crawler has access to.
- A URL for a git repository of the form `git+https://git.example.com/repo.git`, with optional query parameters `branch` (to specify a particular branch to use) and `path` (to specify a relative path to a directory within the git repository where the custom behaviors are located). This should be a git repo the crawler has access to without additional auth.

### Examples

#### Local filepath (directory)

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net --customBehaviors /custom-behaviors/
```

#### Local filepath (file)

```sh
docker run -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net --customBehaviors /custom-behaviors/custom.js
```

#### URL

```sh
docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://specs.webrecorder.net --customBehaviors https://example.com/custom-behavior-1 --customBehaviors https://example.org/custom-behavior-2 
```

#### Git repository

```sh
docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://example.com/ --customBehaviors "git+https://git.example.com/custom-behaviors?branch=dev&path=path/to/behaviors"
```

## Creating Custom Behaviors

A custom behavior file can be in one of the following supported formats:
- JSON User Flow
- JavaScript / Typescript (compiled to JavaScript)

### JSON Flow Behaviors

Browsertrix Crawler 1.6 and up supports replaying the JSON User Flow format generated by [DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder), which is built-in to Chrome devtools.

This format can be generated by using the DevTools Recorder to create a series of steps, which are serialized to JSON.

The format represents a series of steps that should happen on a particular page.

The recorder is capable of picking the right selectors interactively and supports events such as `click`, `change`, `waitForElement` and more. See the [feature reference](https://developer.chrome.com/docs/devtools/recorder/reference) for a more complete list.

#### User Flow Extensions

Browsertrix extends the functionality compared to DevTools Recorder in the following ways:

- Browsertrix Crawler will attempt to continue even if initial step fails, for up to 3 failures.

- If a step is repeated 3 or more times, Browsertrix Crawler will attempt to repeat the step as far as it can until the step fails.

- Browsertrix Crawler ignores the `navigate` and `viewport` step. The `navigate` event is used to match when a particular user flow should run, but does not navigate away from the page.

- If `navigate` step is removed, user flow can run on every page in the crawler.

- A `customStep` step with name `runOncePerCrawl` can be added to indicate that a user flow should run only once for a given crawl.

### JavaScript Behaviors

The main native format of custom behaviors is a Javascript class.

There should be a single class per file, and it should be of the following format:

#### Behavior Class

```javascript
class MyBehavior
{
  // required: an id for this behavior, will be displayed in the logs
  // when the behavior is run.
  static id = "My Behavior Id";

  // required: a function that checks if a behavior should be run
  // for a given page.
  // This function can check the DOM / window.location to determine
  // what page it is on. The first behavior that returns 'true'
  // for a given page is used on that page.
  static isMatch() {
    return window.location.href === "https://my-site.example.com/";
  }

  // required: typically should be left as-is.
  // must return an object. `state` and `opts` properties of that object
  // will be loaded into ctx when the behavior is run, if provided.
  // this could be useful for injecting behaviors or if browsertrix
  // and archiveweb.page allow passing options to custom behaviors in
  // the future.
  static init() {
    return {};
  }

  // optional: if true, will also check isMatch() and possibly run
  // this behavior in each iframe.
  // if false, or not defined, this behavior will be skipped for iframes.
  static runInIframe = false;

  // optional: if defined, provides a way to define a custom way to determine
  // when a page has finished loading beyond the standard 'load' event.
  //
  // if defined, the crawler will await 'awaitPageLoad()' before moving on to
  // post-crawl processing operations, including link extraction, screenshots,
  // and running main behavior
  async awaitPageLoad() {

  }

  // required: the main behavior async iterator, which should yield for
  // each 'step' in the behavior.
  // When the iterator finishes, the behavior is done.
  // (See below for more info)
  async* run(ctx) {
    //... yield ctx.getState("starting behavior");

    // do something

    //... yield ctx.getState("a step has been performed");
  }
}
```

#### Behavior run() loop

The `run()` loop provides the main loop for the behavior to run. It must be an [async iterator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncIterator), which means that it can optionally call `yield` to return state to the crawler and allow it to print the state.

For example, a behavior that iterates over elements and then clicks them either once or twice (based on the value of a custom `.clickTwice` property) could be written as follows:

```javascript
  async* run(ctx) {
    let click = 0;
    let dblClick = 0;
    for await (const elem of document.querySelectorAll(".my-selector")) {
      if (elem.clickTwice) {
        elem.click();
        elem.click();
        dblClick++;
      } else {
        elem.click();
        click++;
      }
      ctx.log({msg: "Clicked on elem", click, dblClick});
    }
  }
```

This behavior will run to completion and log every time a click event is made. However, this behavior can not be paused and resumed (supported in ArchiveWeb.page) and generally can not be interrupted.

One approach is to yield after every major 'step' in the behavior, for example:

```javascript
  async* run(ctx) {
    let click = 0;
    let dblClick = 0;
    for await (const elem of document.querySelectorAll(".my-selector")) {
      if (elem.clickTwice) {
        elem.click();
        elem.click();
        dblClick++;
        // allows behavior to be paused here
        yield {msg: "Double-clicked on elem", click, dblClick};
      } else {
        elem.click();
        click++;
        // allows behavior to be paused here
        yield {msg: "Single-clicked on elem", click, dblClick};
      }
    }
  }
```

The data that is yielded will be logged in the `behaviorScriptCustom` context.

This allows for the behavior to log the current state of the behavior and allow for it to be gracefully
interrupted after each logical 'step'.

#### getState() function

A common pattern is to increment a particular counter, and then return the whole state.

A convenience function `getState()` is provided to simplify this and avoid the need to create custom counters.

Using this standard function, the above code might be condensed as follows:

```javascript
  async* run(ctx) {
    const { Lib } = ctx;
    for await (const elem of document.querySelectorAll(".my-selector")) {
      if (elem.clickTwice) {
        elem.click();
        elem.click();
        yield Lib.getState("Double-Clicked on elem", "dblClick");
      } else {
        elem.click();
        yield Lib.getState("Single-Clicked on elem", "click");
      }
    }
  }
```

#### Utility Functions

In addition to `getState()`, Browsertrix Behaviors includes [a small library of other utility functions](https://github.com/webrecorder/browsertrix-behaviors/blob/main/src/lib/utils.ts) which are available to behaviors under `ctx.Lib`.

Some of these functions which may be of use to behaviors authors are:

- `scrollAndClick`: scroll element into view and click
- `sleep`: sleep for specified timeout (ms)
- `waitUntil`: wait until a certain predicate is true
- `waitUntilNode`: wait until a DOM node exists
- `xpathNode`: find a DOM node by xpath
- `xpathNodes`: find and iterate all DOM nodes by xpath
- `xpathString`: find a string attribute by xpath
- `iterChildElem`: iterate over all child elements of given element
- `iterChildMatches`: iterate over all child elements that match a specific xpath
- `isInViewport`: determine if a given element is in the visible viewport
- `scrollToOffset`: scroll to particular offset
- `scrollIntoView`: smoothly scroll particular element into view
- `getState`: increment a state counter and return all state counters + string message
* `addLink`: add a given URL to the crawl queue

More detailed references will be added in the future.

## Fail On Content Check

In Browsertrix Crawler 1.7.0 and higher, the `--failOnContentCheck` option will result in a crawl failing if a behavior detects the presence or absence of certain content on a page in its `awaitPageLoad()` callback. By default, this is used to fail a crawl if site-specific behaviors determine that the user is not logged in on the following sites:

- Facebook
- Instagram
- TikTok
- X

It is also used to fail crawls with YouTube videos if one of the videos is found not to play.

It is possible to add content checks to custom behaviors. To do so, include an `awaitPageLoad` method on the behavior and use the `ctx.Lib` function `assertContentValid` to check for content and fail the behavior with a specified reason if it is not found.

For an example, see the following `awaitPageLoad` example from the site-specific behavior for X:

```javascript
async awaitPageLoad(ctx: any) {
  const { sleep, assertContentValid } = ctx.Lib;
  await sleep(5);
  assertContentValid(() => !document.documentElement.outerHTML.match(/Log In/i), "not_logged_in");
}
```
