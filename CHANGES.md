## CHANGES

v0.8.0
- Switch to Chrome/Chromium 109
- Convert to ESM module
- Add ad blocking via request interception (#173)
- new setting: add support for specifying language via the --lang flag by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/186
- Add screenshot functionality by @tw4l in https://github.com/webrecorder/browsertrix-crawler/pull/188
- Remove dead pywb configuration by @edsu in https://github.com/webrecorder/browsertrix-crawler/pull/198
- Use VNC for headful profile creation by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/197
- arg parsing fix: by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/200
- Improve crawler logging by @tw4l in https://github.com/webrecorder/browsertrix-crawler/pull/195
- Add requests[socks] python dependency by @kuechensofa in https://github.com/webrecorder/browsertrix-crawler/pull/201
- Add RedisCrawlState test by @tw4l in https://github.com/webrecorder/browsertrix-crawler/pull/208
- crawl state: add getPendingList() to return pending state from either… by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/205
- Serialize Redis pending pages as JSON objects by @tw4l in https://github.com/webrecorder/browsertrix-crawler/pull/212
- behaviors: don't run behaviors in iframes that are about:blank or are… by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/211
- Fix --overwrite CLI flag by @tw4l in https://github.com/webrecorder/browsertrix-crawler/pull/220
- deps: bump pywb to 2.7.3 by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/222
- update behaviors to 0.4.1, rename 'Behavior line' -> 'Behavior log' by @ikreymer in https://github.com/webrecorder/browsertrix-crawler/pull/223

v0.7.1
- Fix for warcio.js by @ikreymer in #178
- Guard against pre-existing user/group by @edsu in #176
- Fix incorrect combineWARCs property in README.md by @Georift in #180

v0.7.0
- Update to Chrome/Chromium 101 - (0.7.0 Beta 0) by @ikreymer in #144
- Add --netIdleWait, bump dependencies (0.7.0-beta.2) by @ikreymer in #145
- Update README.md by @atomotic in #147
- Wait Default + Logging Improvements by @ikreymer in #153
- Page-reuse concurrency + Browser Repair + Screencaster Cleanup Improvements by @ikreymer in #157
- Logging and browser improvements: by @ikreymer in #158
- pending wait: set max pending request wait to 120 seconds by @ikreymer in #161
- Default Wait-Time Improvements by @ikreymer in #162
- Interrupt Handling Fixes by @ikreymer in #167
- Run in Docker as User by @edsu in #171


v0.6.0

- Add a --waitOnDone option, which has browsertrix crawler wait when finished (for use with Browsertrix Cloud)
- When running with redis shared state, set the :status field to running, failing/failed or done to let job controller know crawl is finished.
- Set redis state to failing in case of exception, set to failed in case of >3 or more failed exits within 60 seconds (but don't mark as failed if all pages are finished and >0 pages.
- When receiving a SIGUSR1, don't wait on down (assume final exit due to scale down).
- More efficient screencasting, don't end screencasting when page ends, only when target is destroyed!
- Keep same screencasting connection from one page to next, as the target are reused in 'window' concurrency mode
- Size limit (in bytes) via --sizeLimit
- Total time limit (in bytes) via --timeLimit
- Overwrite collection (delete existing) via --overwrite
- Fixes to interrupting a single instance in a shared state crawl
- force all cookies, including session cookies, to fixed duration in days, configurable via --cookieDays


v0.5.0
- Scope: support for `scopeType: domain` to include all subdomains and ignoring 'www.' if specified in the seed.
- Profiles: support loading remote profile from URL as well as local file
- Non-HTML Pages: Load non-200 responses in browser, even if non-html, fix waiting issues with non-HTML pages (eg. PDFs)
- Config options: Fix setting user-agent
- Page behavior: latest browsertrix-behaviors, also add experimental Cloudflare interstitial wait.
- Error handling: better error handling for redis errors
- State: Support loading of crawl state from config.yaml
- State: Support serialization of crawl state to `crawls` subdirectory, both while running (keeping last N states) and on exit.
- State: Graceful saving of crawl state on ctrl+c interrupt
- State: Memory or Redis based crawl state
- Config: Support additional options via `CRAWL_ARGS` environment variable
- WACZ Upload: Support for S3 upload of WACZ upon crawl completion
- WACZ Upload: HTTP/Redis webhook to notify of upload completion
- Crawl Scope: Support for `extraHops` to optionally crawl an extra hop beyond scope
- Signing: Support for optional signing of WACZ
- Dependencies: update to latest pywb, wacz and browsertrix-behaviors packages


v0.4.4
- Page Block Rules Fix: 'request already handled' errors by avoiding adding duplicate handlers to same page.
- Page Block Rules Fix: await all continue/abort() calls and catch errors.
- Page Block Rules: Don't apply to top-level page, print warning and recommend scope rules instead.
- Setup: Attempt to create the crawl working directory (cwd) specified via --cwd if it doesn't exist.
- Scope Types: Rename 'none' -> 'page' (single page only) and 'page' -> 'page-spa' (page with hashtags).
- README: Add more scope rule examples, clarify distinction between scope rules and block rules.
- README: Update old type -> scopeType, list new scope types.

v0.4.3
- BlockRules Fixes: When considering the 'inFrameUrl' for a navigation request for an iframe, use URL of parent frame.
- BlockRules Fixes: Always allow pywb proxy scripts.
- Logging: Improved debug logging for block rules (log blocked requests and conditional iframe requests) when 'debug' set in 'logging'

v0.4.2
- Compose/docs: Build latest image by default, update README to refer to latest image
- Fix typo in `crawler.capturePrefix` that resulted in `directFetchCapture()` always failing
- Tests: Update all tests to use `test-crawls` directory
- extractLinks() just extracts links from default selectors, allows custom driver to filter results
- loadPage() accepts a list of selector options with selector, extract, and isAttribute settings for further customization of link extraction

v0.4.1
- BlockRules Optimizations: don't intercept requests if no blockRules
- Profile Creation: Support extending existing profile by passing a --profile param to load on startup
- Profile Creation: Set default window size to 1600x900, add --windowSize param for setting custom size
- Behavior Timeouts: Add --behaviorTimeout to specify custom timeout for behaviors, in seconds (defaulting to 90 seconds)
- Load Wait Default: Switch to 'load,networkidle2' to speed-up waiting for initial load
- Multi-platform build: Support building for amd64 and Arm using oldwebtoday/chrome:91 images (check for google-chrome and chromium-browser automatically)
- CI: Build a multi-platform (amd64 and arm64) image on each release

v0.4.0
- YAML based config, specifyable via --config property or via stdin (with '--config stdin')
- Support for different scope types ('page', 'prefix', 'host', 'any', 'none') + crawl depth at crawl level
- Per-Seed scoping, including different scope types, or depth and include/exclude rules configurable per seed in 'seeds' list via YAML config
- Support for 'blockRules' for blocking certain URLs from being stored in WARCs, conditional blocking for iframe based on contents, and iframe URLs (see README for more details)
- Interactive profile creation: creating profiles by interacting with embedded browser loaded in the browser (see README for more details).
- Screencasting: streaming the output of each window via websocket-based streaming, configurable with --screencastPort option
- New 'window' based parallelization: Open each worker in new window in same session
- Simplified custom driver config, default calls 'loadPage'
- Refactor arg parsing, other auxiliary functions into separate utils files
- Image customization: support for customizing browser image, eg. building with Chromium instead of Chrome, support for ARM architecture builds (see README for more details).
- Update to latest pywb (2.5.0b4), browsertrix-behaviors (0.2.3), py-wacz (0.3.1)

v0.3.2
- Added a `--urlFile` option: Allows users to specify a .txt file list of exact URLs to crawl (one URL per line).


v0.3.1
- Improved shutdown wait: Instead of waiting for 5 secs, wait until all pending requests are written to WARCs
- Bug fix: Use async APIs for combine WARC to avoid spurious issues with multiple crawls
- Behaviors Update to Behaviors to 0.2.1, with support for facebook pages


v0.3.0
- WARC Combining: `--combineWARC` and `--rolloverSize` flags for generating combined WARC at end of crawl, each WARC upto specified rolloverSize
- Profiles: Support for creating reusable browser profiles, stored as tarballs, and running crawl with a login profile (see README for more info)
- Behaviors: Switch to Browsertrix Behaviors v0.1.1 for in-page behaviors
- Logging: Customizable logging options via `--logging`, including behavior log, behavior debug log, pywb log and crawl stats (default)
