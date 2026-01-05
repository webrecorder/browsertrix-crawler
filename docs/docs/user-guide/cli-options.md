# All Command-Line Options

The Browsertrix Crawler Docker image currently accepts the following parameters, broken down by entrypoint:

## crawler

```
Options:
      --help                                Show help                  [boolean]
      --version                             Show version number        [boolean]
      --seeds, --url                        The URL to start crawling from
                                                           [array] [default: []]
      --seedFile, --urlFile                 If set, read a list of seed urls, on
                                            e per line, from the specified
                                                                        [string]
  -w, --workers                             The number of workers to run in para
                                            llel           [number] [default: 1]
      --crawlId, --id                       A user provided ID for this crawl or
                                             crawl configuration (can also be se
                                            t via CRAWL_ID env var), defaults to
                                             combination of Docker container hos
                                            tname and collection        [string]
      --waitUntil                           Puppeteer page.goto() condition to w
                                            ait for before continuing, can be mu
                                            ltiple separated by ','
   [array] [choices: "load", "domcontentloaded", "networkidle0", "networkidle2"]
                                              [default: ["load","networkidle2"]]
      --depth                               The depth of the crawl for all seeds
                                                          [number] [default: -1]
      --extraHops                           Number of extra 'hops' to follow, be
                                            yond the current scope
                                                           [number] [default: 0]
      --pageLimit, --limit                  Limit crawl to this number of pages
                                                           [number] [default: 0]
      --maxPageLimit                        Maximum pages to crawl, overriding
                                            pageLimit if both are set
                                                           [number] [default: 0]
      --pageLoadTimeout, --timeout          Timeout for each page to load (in se
                                            conds)        [number] [default: 90]
      --scopeType                           A predefined scope of the crawl. For
                                             more customization, use 'custom' an
                                            d set scopeIncludeRx regexes
  [string] [choices: "page", "page-spa", "prefix", "host", "domain", "any", "cus
                                                                           tom"]
      --scopeIncludeRx, --include           Regex of page URLs that should be in
                                            cluded in the crawl (defaults to the
                                             immediate directory of URL)[string]
      --scopeExcludeRx, --exclude           Regex of page URLs that should be ex
                                            cluded from the crawl.      [string]
      --allowHashUrls                       Allow Hashtag URLs, useful for singl
                                            e-page-application crawling or when
                                            different hashtags load dynamic cont
                                            ent
      --selectLinks, --linkSelector         One or more selectors for extracting
                                             links, in the format [css selector]
                                            ->[property to use],[css selector]->
                                            @[attribute to use]
                                            [array] [default: ["a[href]->href"]]
      --clickSelector                       Selector for elements to click when
                                            using the autoclick behavior
                                                         [string] [default: "a"]
      --blockRules                          Additional rules for blocking certai
                                            n URLs from being loaded, by URL reg
                                            ex and optionally via text match in
                                            an iframe      [array] [default: []]
      --blockMessage                        If specified, when a URL is blocked,
                                             a record with this error message is
                                             added instead[string] [default: ""]
      --blockAds, --blockads                If set, block advertisements from be
                                            ing loaded (based on Stephen Black's
                                             blocklist)
                                                      [boolean] [default: false]
      --adBlockMessage                      If specified, when an ad is blocked,
                                             a record with this error message is
                                             added instead[string] [default: ""]
  -c, --collection                          Collection name / directory to crawl
                                             into[string] [default: "crawl-@ts"]
      --headless                            Run in headless mode, otherwise star
                                            t xvfb    [boolean] [default: false]
      --driver                              Custom driver for the crawler, if an
                                            y                           [string]
      --generateCDX, --generatecdx, --gene  If set, generate merged index in CDX
      rateCdx                               J format  [boolean] [default: false]
      --combineWARC, --combinewarc, --comb  If set, combine the warcs
      ineWarc                                         [boolean] [default: false]
      --rolloverSize                        If set, declare the rollover size
                                                  [number] [default: 1000000000]
      --generateWACZ, --generatewacz, --ge  If set, generate WACZ on disk
      nerateWacz                                      [boolean] [default: false]
      --useSHA1                             If set, sha-1 instead of sha-256 has
                                            hes will be used for creating record
                                            s         [boolean] [default: false]
      --logging                             Logging options for crawler, can inc
                                            lude: stats (enabled by default), js
                                            errors, debug
                                                    [array] [default: ["stats"]]
      --logLevel                            Comma-separated list of log levels t
                                            o include in logs
                                                           [array] [default: []]
      --context, --logContext               Comma-separated list of contexts to
                                            include in logs
  [array] [choices: "general", "worker", "recorder", "recorderNetwork", "writer"
  , "state", "redis", "storage", "text", "exclusion", "screenshots", "screencast
  ", "originOverride", "healthcheck", "browser", "blocking", "behavior", "behavi
  orScript", "behaviorScriptCustom", "jsError", "fetch", "pageStatus", "memorySt
   atus", "crawlStatus", "links", "sitemap", "wacz", "replay", "proxy", "scope",
                                                         "robots"] [default: []]
      --logExcludeContext                   Comma-separated list of contexts to
                                            NOT include in logs
  [array] [choices: "general", "worker", "recorder", "recorderNetwork", "writer"
  , "state", "redis", "storage", "text", "exclusion", "screenshots", "screencast
  ", "originOverride", "healthcheck", "browser", "blocking", "behavior", "behavi
  orScript", "behaviorScriptCustom", "jsError", "fetch", "pageStatus", "memorySt
   atus", "crawlStatus", "links", "sitemap", "wacz", "replay", "proxy", "scope",
                 "robots"] [default: ["recorderNetwork","jsError","screencast"]]
      --text                                Extract initial (default) or final t
                                            ext to pages.jsonl or WARC resource
                                            record(s)
                       [array] [choices: "to-pages", "to-warc", "final-to-warc"]
      --cwd                                 Crawl working directory for captures
                                            . If not set, defaults to process.cw
                                            d()    [string] [default: "/crawls"]
      --mobileDevice                        Emulate mobile device by name from:
                                            https://github.com/puppeteer/puppete
                                            er/blob/main/packages/puppeteer-core
                                            /src/common/Device.ts       [string]
      --userAgent                           Override user-agent with specified s
                                            tring                       [string]
      --userAgentSuffix                     Append suffix to existing browser us
                                            er-agent (ex: +MyCrawler, info@examp
                                            le.com)                     [string]
      --useSitemap, --sitemap               If enabled, check for sitemaps at /s
                                            itemap.xml, or custom URL if URL is
                                            specified
      --sitemapFromDate, --sitemapFrom      If set, filter URLs from sitemaps to
                                             those greater than or equal to (>=)
                                             provided ISO Date string (YYYY-MM-D
                                            D or YYYY-MM-DDTHH:MM:SS or partial
                                            date)                       [string]
      --sitemapToDate, --sitemapTo          If set, filter URLs from sitemaps to
                                             those less than or equal to (<=) pr
                                            ovided ISO Date string (YYYY-MM-DD o
                                            r YYYY-MM-DDTHH:MM:SS or partial dat
                                            e)                          [string]
      --statsFilename                       If set, output stats as JSON to this
                                             file. (Relative filename resolves t
                                            o crawl working directory)  [string]
      --behaviors                           Which background behaviors to enable
                                             on each page
         [array] [default: ["autoplay","autofetch","autoscroll","siteSpecific"]]
      --behaviorTimeout                     If >0, timeout (in seconds) for in-p
                                            age behavior will run on each page.
                                            If 0, a behavior can run until finis
                                            h.            [number] [default: 90]
      --postLoadDelay                       If >0, amount of time to sleep (in s
                                            econds) after page has loaded, befor
                                            e taking screenshots / getting text
                                            / running behaviors
                                                           [number] [default: 0]
      --pageExtraDelay, --delay             If >0, amount of time to sleep (in s
                                            econds) after behaviors before movin
                                            g on to next page
                                                           [number] [default: 0]
      --profile, --loadProfile              Path or HTTP(S) URL to tar.gz file w
                                            hich contains the browser profile di
                                            rectory                     [string]
      --saveProfile                         If set, save profile if crawl succee
                                            ded successfully. If no value provid
                                            ed, save back to save location as sp
                                            ecified in --profile
      --screenshot                          Screenshot options for crawler, can
                                            include: view, thumbnail, fullPage,
                                            fullPageFinal
   [array] [choices: "view", "thumbnail", "fullPage", "fullPageFinal"] [default:
                                                                             []]
      --screencastPort                      If set to a non-zero value, starts a
                                            n HTTP server with screencast access
                                            ible on this port
                                                           [number] [default: 0]
      --screencastRedis                     If set, will use the state store red
                                            is pubsub for screencasting. Require
                                            s --redisStoreUrl to be set
                                                      [boolean] [default: false]
      --warcInfo, --warcinfo                Optional fields added to the warcinf
                                            o record in combined WARCs
      --redisStoreUrl                       If set, url for remote redis server
                                            to store state. Otherwise, using loc
                                            al redis instance
                                  [string] [default: "redis://localhost:6379/0"]
      --saveState                           If the crawl state should be seriali
                                            zed to the crawls/ directory. Defaul
                                            ts to 'partial', only saved when cra
                                            wl is interrupted
           [string] [choices: "never", "partial", "always"] [default: "partial"]
      --saveStateInterval                   If save state is set to 'always', al
                                            so save state during the crawl at th
                                            is interval (in seconds)
                                                         [number] [default: 300]
      --saveStateHistory                    Number of save states to keep during
                                             the duration of a crawl
                                                           [number] [default: 5]
      --sizeLimit                           If set, save state and exit if size
                                            limit exceeds this value
                                                           [number] [default: 0]
      --diskUtilization                     If set, save state and exit if disk
                                            utilization exceeds this percentage
                                            value          [number] [default: 0]
      --timeLimit                           If set, save state and exit after ti
                                            me limit, in seconds
                                                           [number] [default: 0]
      --healthCheckPort                     port to run healthcheck on
                                                           [number] [default: 0]
      --overwrite                           overwrite current crawl data: if set
                                            , existing collection directory will
                                             be deleted before crawl is started
                                                      [boolean] [default: false]
      --waitOnDone                          if set, wait for interrupt signal wh
                                            en finished instead of exiting
                                                      [boolean] [default: false]
      --restartsOnError                     if set, assume will be restarted if
                                            interrupted, don't run post-crawl pr
                                            ocesses on interrupt
                                                      [boolean] [default: false]
      --netIdleWait                         number of seconds to wait for networ
                                            k idle after page load and after beh
                                            aviors are done (default: 2)
                                                           [number] [default: 2]
      --netIdleMaxRequests                  max active requests allowed for netw
                                            ork to be considered idle
                                                                    [default: 1]
      --lang                                if set, sets the language used by th
                                            e browser, should be ISO 639 languag
                                            e[-country] code            [string]
      --title                               If set, write supplied title into WA
                                            CZ datapackage.json metadata[string]
      --description, --desc                 If set, write supplied description i
                                            nto WACZ datapackage.json metadata
                                                                        [string]
      --originOverride                      if set, will redirect requests from
                                            each origin in key to origin in the
                                            value, eg. --originOverride https://
                                            host:port=http://alt-host:alt-port
                                                           [array] [default: []]
      --logErrorsToRedis                    If set, write error messages to redi
                                            s         [boolean] [default: false]
      --logBehaviorsToRedis                 If set, write behavior script messag
                                            es to redis
                                                      [boolean] [default: false]
      --writePagesToRedis                   If set, write page objects to redis
                                                      [boolean] [default: false]
      --maxPageRetries, --retries           If set, number of times to retry a p
                                            age that failed to load before page
                                            is considered to have failed
                                                           [number] [default: 2]
      --failOnFailedSeed                    If set, crawler will fail with exit
                                            code 1 if any seed fails. When combi
                                            ned with --failOnInvalidStatus,will
                                            result in crawl failing with exit co
                                            de 1 if any seed has a 4xx/5xx respo
                                            nse       [boolean] [default: false]
      --failOnFailedLimit                   If set, save state and exit if numbe
                                            r of failed pages exceeds this value
                                                           [number] [default: 0]
      --failOnInvalidStatus                 If set, will treat pages with 4xx or
                                             5xx response as failures. When comb
                                            ined with --failOnFailedLimit or --f
                                            ailOnFailedSeed may result in crawl
                                            failing due to non-200 responses
                                                      [boolean] [default: false]
      --failOnContentCheck                  If set, allows for behaviors to fail
                                             a crawl with custom reason based on
                                             content (e.g. logged out)
                                                      [boolean] [default: false]
      --customBehaviors                     Custom behavior files to inject. Val
                                            id values: URL to file, path to file
                                            , path to directory of behaviors, UR
                                            L to Git repo of behaviors (prefixed
                                             with git+, optionally specify branc
                                            h and relative path to a directory w
                                            ithin repo as branch and path query
                                            parameters, e.g. --customBehaviors "
                                            git+https://git.example.com/repo.git
                                            ?branch=dev&path=some/dir"
                                                           [array] [default: []]
      --saveStorage                         if set, will store the localStorage/
                                            sessionStorage data for each page as
                                             part of WARC-JSON-Metadata field
                                                                       [boolean]
      --debugAccessRedis                    if set, runs internal redis without
                                            protected mode to allow external acc
                                            ess (for debugging)        [boolean]
      --debugAccessBrowser                  if set, allow debugging browser on p
                                            ort 9222 via CDP           [boolean]
      --warcPrefix                          prefix for WARC files generated, inc
                                            luding WARCs added to WACZ  [string]
      --serviceWorker, --sw                 service worker handling: disabled, e
                                            nabled, or disabled with custom prof
                                            ile
   [choices: "disabled", "disabled-if-profile", "enabled"] [default: "disabled"]
      --proxyServer                         if set, will use specified proxy ser
                                            ver. Takes precedence over any env v
                                            ar proxy settings           [string]
      --proxyServerPreferSingleProxy        if set, and both proxyServer and pro
                                            xyServerConfig are provided, the pro
                                            xyServer value will be preferred
                                                      [boolean] [default: false]
      --proxyServerConfig                   if set, path to yaml/json file that
                                            configures multiple path servers per
                                             URL regex                  [string]
      --dryRun                              If true, no archive data is written
                                            to disk, only pages and logs (and op
                                            tionally saved state).     [boolean]
      --qaSource                            Required for QA mode. Source (WACZ o
                                            r multi WACZ) for QA        [string]
      --qaDebugImageDiff                    if specified, will write crawl.png,
                                            replay.png and diff.png for each pag
                                            e where they're different  [boolean]
      --sshProxyPrivateKeyFile              path to SSH private key for SOCKS5 o
                                            ver SSH proxy connection    [string]
      --sshProxyKnownHostsFile              path to SSH known hosts file for SOC
                                            KS5 over SSH proxy connection
                                                                        [string]
      --extraChromeArgs                     Extra arguments to pass directly to
                                            the Chrome instance (space-separated
                                             or multiple --extraChromeArgs)
                                                           [array] [default: []]
      --useRobots, --robots                 If set, fetch and respect page disal
                                            lows specified in per-host robots.tx
                                            t         [boolean] [default: false]
      --robotsAgent                         Agent to check in addition to '*' fo
                                            r robots rules
                                           [string] [default: "Browsertrix/1.x"]
      --config                              Path to YAML config file
```

## create-login-profile

```
Options:
  --help                    Show help                                  [boolean]
  --version                 Show version number                        [boolean]
  --url                     The URL of the login page        [string] [required]
  --user                    The username for the login. If not specified, will b
                            e prompted                                  [string]
  --password                The password for the login. If not specified, will b
                            e prompted (recommended)                    [string]
  --filename                The filename for the profile tarball, stored within
                            /crawls/profiles if absolute path not provided
                           [string] [default: "/crawls/profiles/profile.tar.gz"]
  --debugScreenshot         If specified, take a screenshot after login and save
                             as this filename         [boolean] [default: false]
  --headless                Run in headless mode, otherwise start xvfb
                                                      [boolean] [default: false]
  --automated               Start in automated mode, no interactive browser
                                                      [boolean] [default: false]
  --interactive             Deprecated. Now the default option!
                                                      [boolean] [default: false]
  --shutdownWait            Shutdown browser in interactive after this many seco
                            nds, if no pings received      [number] [default: 0]
  --profile                 Path or HTTP(S) URL to tar.gz file which contains th
                            e browser profile directory   [string] [default: ""]
  --windowSize              Browser window dimensions, specified as: width,heigh
                            t                    [string] [default: "1360,1020"]
  --cookieDays              If >0, set all cookies, including session cookies, t
                            o have this duration in days before saving profile
                                                           [number] [default: 7]
  --proxyServer             if set, will use specified proxy server. Takes prece
                            dence over any env var proxy settings       [string]
  --proxyServerConfig       if set, path to yaml/json file that configures multi
                            ple path servers per URL regex              [string]
  --sshProxyPrivateKeyFile  path to SSH private key for SOCKS5 over SSH proxy co
                            nnection                                    [string]
  --sshProxyKnownHostsFile  path to SSH known hosts file for SOCKS5 over SSH pro
                            xy connection                               [string]
```
