# Exit codes

The crawler uses following exit codes to indicate crawl result.

| Code | Name | Description |
|--|--|--|
| 0 | Success | Crawl completed normally |
| 1 | GenericError | SIGINT or SIGTERM signal forced crawler to stop |
| 3 | OutOfSpace | Disk is already full |
| 9 | Failed | Something bad happened during the crawl, might be worth to retry it |
| 10 | BrowserCrashed | Browser used to fetch pages has crashed |
| 11 | SignalInterrupted | Cancellation has been requested |
| 12 | FailedLimit | Limit on amount of failed pages, configured with `--limit`, has been reached |
| 13 | SignalInterruptedForce | Cancellation has been forced |
| 14 | SizeLimit | Limit on maximum WARC size, configured with `--sizeLimit`, has been reached |
| 15 | TimeLimit | Limit on maximum crawl duration, configured with `--timeLimit`, has been reached |
| 16 | DiskUtilization | Limit on maximum disk usage, configured with `--diskUtilization`, has been reached |
| 17 | Fatal | A fatal (non-retryable) error occured |
| 21 | ProxyError | Unable to establish connection with proxy |