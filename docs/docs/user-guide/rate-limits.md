# Rate Limit / CAPTCHA Page Detection

When crawling, it is often possible to encounter rate limits, CAPTCHAs, or auth pages that are shown instead of valid content that the crawler is intending to capture.
These 'auth-walled' pages are often implemented for good reason, and bypassing such limits is outside of the scope of the crawler.

However, the crawler can *detect* such pages and avoid archiving 'bad'/undesirable data.

The crawler includes several options to help with this. 

When pages are flagged as rate limited, the pages are still loaded in the browser, but the content is not archived.
Instead, the pages may be queued to be retried at a later time or skipped altogether.

## Flagging Rate Limited / Auth-walled pages

The simplest mechanism for detection is by checking the status code. By default, the crawler now skips all pages that have a 403, 429, or 503 status code. This list can be customized with the `--rateLimitStatusCodes` setting, which accepts a list of status codes to always skip and retry.

The crawler also includes a custom option `--rateLimitOnMatch`, which can take additional values in the form of `<regex>` or `<regex>:<status>`, e.g. `--rateLimitOnMatch <regex-1> --rateLimitOnMatch <regex-2>:<status>`. This setting allows for custom detection of CAPTCHAs and rate-limited pages based on page content, and optionally status code, so even 200 pages can be flagged as rate limited.

## Rate Limit Counters

The crawler also keeps track of how many pages have been flagged as limited during the duration of the crawl,
by combination of status code and direct fetch/browser-based indicator. These stats are stored in Redis as part of the crawl stats.

The crawler also keeps track of how many pages have been rate limited *within the last N seconds*, set by the `--rateLimitTimeout` and defaulting to 300 seconds (5 minutes).

If a site provides a `Retry-After` header, for example with a 429 response, the header value is used instead of the global default set in `--rateLimitTimeout`.

## Rate Limit Retry Count

By default, rate limited pages are retried indefinitely, allowing the crawl to possibly complete but at a much slower pace. If the pages are blocked due to auth requirements it may be possible to add a browser profile and restart the crawl, allowing for previously flagged pages to be captured successfully.

However, it may be desirable to set a total number of retries for pages flagged as rate limited, which can be done
by setting `--rateLimitMaxRetries` to a value >= 0, where 0 implies no retries at all.

## Interrupting Crawl on Rate Limit Threshold

By default, the crawler will continue, skipping rate limited pages and retrying them indefinitely, to match existing behavior.

If the `--rateLimitInterruptCount M` flag is set, the crawler will exit with a rate limit exit code (exit code 21) after M rate limited pages within the N seconds, configured via `--rateLimitTimeout`.

This can allow a job runner or other system that starts and monitors the crawler container to implement an exponential backoff system if the crawler repeatedly exits due to being rate limited.
The Browsertrix application provides this through built-in exponential backoff available in Kubernetes, where the system
will restart the crawler in increasing intervals if continuously rate limited, up to once every 5 minutes.

Additionally, if direct fetch reaches this threshold, further direct fetches will also be skipped until the timeout expires.

If any page loads successfully, the rate limit counter is cleared.

## Caveats and Multi-Domain Crawling

It should be noted that the rate limits are applied globally and not per seed or per domain, and it may not always be desirable to interrupt a crawl containing many seeds across different domains when a rate limit is reached.
The rate limit interrupt threshold is disabled by default for this reason.

For multi-domain crawling the threshold could be set to a large number so that if multiple domains are flagged as rate limited the crawl is still interrupted, while for a single domain crawl the number may be set lower.
It may make sense to set `--rateLimitMaxRetries` to a fixed value so that larger crawls do eventually finish with certain pages skipped as rate limited.

Finally, depending on the reason for the 'auth-wall' on each domain, the crawler may or may not be able to complete the crawl on each domain.
- For 429 errors and 503 errors, waiting and retrying may be successful.
- For 403 errors, logging in with a browser profile may provide additional access.
- Other sites and custom CAPTCHA pages may require additional permission to be allowed to crawl the sites.

If facing repeated errors, requesting permission may be the best approach to successfully crawl a domain.