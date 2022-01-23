## CHANGES

v0.5.0
- State: Support for serialization and reloading of crawl state to config.yaml
- State: Graceful saving of crawl state on ctrl+c interrupt
- State: Memory or Redis based crawl state
- Config: Aadditional crawl config via env var
- WACZ Upload: Support for S3 upload of WACZ upon crawl completion
- WACZ Upload: HTTP/Redis webhook to notify of upload completion
- Crawl Scope: Support for `extraHops` to optionally crawl an extra hop beyond scope
- Signing: Support for optional signing of WACZ
- Dependencies: update to latest pywb and wacz packages

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
- Bug fix: Use async APIs for combine WARC to avoid spurrious issues with multiple crawls
- Behaviors Update to Behaviors to 0.2.1, with support for facebook pages


v0.3.0
- WARC Combining: `--combineWARC` and `--rolloverSize` flags for generating combined WARC at end of crawl, each WARC upto specified rolloverSize
- Profiles: Support for creating reusable browser profiles, stored as tarballs, and running crawl with a login profile (see README for more info)
- Behaviors: Switch to Browsertrix Behaviors v0.1.1 for in-page behaviors
- Logging: Customizable logging options via `--logging`, including behavior log, behavior debug log, pywb log and crawl stats (default)
