# Exit codes

The crawler uses following exit codes to indicate crawl result.

| Code | Name | Description |
|--|--|--|
| 0 | Success | Crawl completed normally |
| 1 | GenericError | Unspecified error, check logs for more details |
| 3 | OutOfSpace | Disk is already full |
| 9 | Failed | Crawl failed unexpectedly, might be worth retrying |
| 10 | BrowserCrashed | Browser used to fetch pages has crashed |
| 11 | SignalInterrupted | Crawl stopped gracefully in response to SIGINT signal |
| 12 | FailedLimit | Limit on amount of failed pages, configured with `--failOnFailedLimit`, has been reached |
| 13 | SignalInterruptedForce | Crawl stopped forcefully in response to SIGTERM or repeated SIGINT signal |
| 14 | SizeLimit | Limit on maximum WARC size, configured with `--sizeLimit`, has been reached |
| 15 | TimeLimit | Limit on maximum crawl duration, configured with `--timeLimit`, has been reached |
| 16 | DiskUtilization | Limit on maximum disk usage, configured with `--diskUtilization`, has been reached |
| 17 | Fatal | A fatal (non-retryable) error occured |
| 21 | ProxyError | Unable to establish connection with proxy |