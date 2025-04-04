# Browser Behaviors

Browsertrix Crawler supports automatically running customized behaviors on each page. These include several different kinds of behaviors, including built-in, background and site-specific behaviors as well as ability to add fully user-defined custom behaviors that can be added to trigger custom actions on certain pages.

## Built-In Behaviors

 The built-in behaviors include the following background behaviors which run 'in the background' checking for changes:
 
 - Autoplay: find and start playing (when possible) and video or audio on the page (and in each iframe).
 - Autofetch: find and start fetching any URLs that may not be fetched by default, such as other resolutions in `img` tags, `data-*`, lazy-loaded resources, etc...
 - Autoclick: selector all tags (default: `a` tag, customizable via `--clickSelector`) that may be clickable and attempt to click them, while avoiding navigation away from the page.

 There is also a built-in 'main' behavior, which runs to completion (or until a timeout is reached):

 - Autoscroll: Determine if a page might need scrolling, and scroll either up or down, while new elements are being added. Continue until timeout or scrolling is no longer possible.

 ## Site Specific Behaviors

 Browsertrix also comes with several 'site-specific' behaviors, which run only on specific sites. These behaviors will run instead of Autoscroll 
 and will run until completion or timeout. Currently, site-specific behaviors include major social media sites.

 Refer to [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) for latest list of site-specific behaviors.

 User-defined custom behaviors are also considered site-specific.
 
## Enabling Behaviors

To enable built-in behaviors, specify them via a comma-separated list passed to the `--behaviors` option. All behaviors except Autoclick are enabled by default, the equivalent of `--behaviors autoscroll,autoplay,autofetch,siteSpecific`. To enable only a single behavior, such as Autoscroll, use `--behaviors autoscroll`.

To only use Autoclick but not Autoscroll, use `--behaviors autoclick,autoplay,autofetch,siteSpecific`.

The `--siteSpecific` flag enables all site-specific behaviors to be enabled, but only one behavior can be run per site, each behavior specifies which
site it should run on.

To disable all behaviors, use `--behaviors ""`.

## Behavior and Page Timeouts

Browsertrix includes a number of timeouts, include before, during and after running behaviors.
The timeouts are as follows:

- `--waitUntil` - how long to wait for page to finish loading, *before* doing anything else.
- `--postLoadDelay` - how long to wait *before* starting any behaviors, but after page has finished loading. A custom behavior can customize override this (see below)
- `--behaviorTimeout` - maximum time to spend on running behaviors site-specific / Autoscroll behaviors (can be less if behavior finishes early).
- `--pageExtraDelay` - how long to wait *after* finishing behaviors (or `behaviorTimeout` has reached) before moving on to next page.


A site-specific behavior (or Autoscroll) will start the page is loaded (at most after `--waitUnitl` seconds) and exactly after `--postLoadDelay` seconds.

The behavior will then run until finished or at most until `--behaviorTimeout` is reached (90 seconds by default.)

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

# Creating Custom Behaviors

The custom behavior file can be in one of the following supported formats.

## JS Behaviors

The main native format of custom behaviors is a Javascript class.
There should be a single class per file, and it should be of the following format:

### Behavior Class

```javascript
class MyBehavior
{
  // required: an id for this behavior, will be displayed in the logs when the behavior is run.
  static id = "My Behavior Id";

  // required: a function that checks if a behavior should be run for a given page.
  // This function can check the DOM / window.location to determine what page it is on.
  //
  // The first behavior that returns 'true' for a given site is used on that page.
  static isMatch() {
    return window.location.href === "https://my-site.example.com/";
  }

  // optional: if true, will also check isMatch() and possibly run this behavior in each iframes.
  // if false, or not defined, this behavior will not be skipped for iframes.
  static runInIframes = false;

  // optional: if defined, provides a way to define a custom way to determine when a page has finished loading
  // beyond the standard 'load' event.
  //
  // if defined, the crawler will await 'awaitPageLoad()' before moving on to post-crawl processing operations,
  // including link-extraction, screenshots, and running main behavior
  async awaitPageLoad() {

  }

  // required: the main behavior async interator, which should yield for each 'step' in the behavior.
  // when the iterator finishes, the behavior is done. (See below for more info)
  async* run(ctx) {
    //... yield ctx.getState("starting behavior");

    // do something

    //... yield ctx.getState("a step has been performed");
  }
}
```

### Behavior run() loop