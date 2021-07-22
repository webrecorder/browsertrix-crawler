## CHANGES

v0.4.1
- BlockRules Optimizations: don't intercept requests if no blockRules
- Profile Creation: Support extending existing profile by passing a --profile param to load on startup
- Behavior Timeouts: Add --behaviorTimeout to specify custom timeout for behaviors, in seconds (defaulting to 90 seconds)
- Load Wait Default: Switch to 'load,networkidle2' to speed-up waiting for initial load
- Multi-platform build: Support building for amd64 and Arm using oldwebtoday/chrome:91 images (check for google-chrome and chromium-browser automatically)
- CI: Builds an amd64 and arm64 images on each release

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
