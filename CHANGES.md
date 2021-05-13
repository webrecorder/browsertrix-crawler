## CHANGES

v0.3.2
- Added the --urlList options: Allows users to specify a .txt file list of exact URLs to crawl (one URL per line).


v0.3.1
- Improved shutdown wait: Instead of waiting for 5 secs, wait until all pending requests are written to WARCs
- Bug fix: Use async APIs for combine WARC to avoid spurrious issues with multiple crawls
- Behaviors Update to Behaviors to 0.2.1, with support for facebook pages


v0.3.0
- WARC Combining: `--combineWARC` and `--rolloverSize` flags for generating combined WARC at end of crawl, each WARC upto specified rolloverSize
- Profiles: Support for creating reusable browser profiles, stored as tarballs, and running crawl with a login profile (see README for more info)
- Behaviors: Switch to Browsertrix Behaviors v0.1.1 for in-page behaviors
- Logging: Customizable logging options via `--logging`, including behavior log, behavior debug log, pywb log and crawl stats (default)
