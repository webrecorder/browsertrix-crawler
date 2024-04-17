---
hide:
  - navigation
  - toc
---

# Home

Welcome to the Browsertrix Crawler official documentation.

Browsertrix Crawler is a simplified browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [Puppeteer](https://github.com/puppeteer/puppeteer) to control one or more [Brave Browser](https://brave.com/) browser windows in parallel. Data is captured through the [Chrome Devtools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) in the browser.

Browsertrix Crawler is a command line application responsible for the core features of [Browsertrix](https://browsertrix.com), Webrecorder's cloud-based web archiving service. See the [Browsertrix documentation](https://docs.browsertrix.cloud/) for more information about Browsertrix, the cloud platform.

!!! note

    This documentation applies to Browsertrix Crawler versions 1.0.0 and above. Documentation for earlier versions of the crawler is available in the [Browsertrix Crawler Github repository](https://github.com/webrecorder/browsertrix-crawler)'s README file in older commits.

## Features

- Single-container, browser based crawling with a headless/headful browser running pages in multiple windows.
- Support for custom browser behaviors, using [Browsertrix Behaviors](https://github.com/webrecorder/browsertrix-behaviors) including autoscroll, video autoplay, and site-specific behaviors.
- YAML-based configuration, passed via file or via stdin.
- Seed lists and per-seed scoping rules.
- URL blocking rules to block capture of specific URLs (including by iframe URL and/or by iframe contents).
- Screencasting: Ability to watch crawling in real-time.
- Screenshotting: Ability to take thumbnails, full page screenshots, and/or screenshots of the initial page view.
- Optimized (non-browser) capture of non-HTML resources.
- Extensible Puppeteer driver script for customizing behavior per crawl or page.
- Ability to create and reuse browser profiles interactively or via automated user/password login using an embedded browser.
- Multi-platform support — prebuilt Docker images available for Intel/AMD and Apple Silicon (M1/M2) CPUs.
- Quality Assurance Crawling - crawl the replay of existing crawls (via WACZ) and produce comparison stats.

## Documentation

If something is missing, unclear, or seems incorrect, please open an [issue](https://github.com/webrecorder/browsertrix-crawler/issues?q=is%3Aissue+is%3Aopen+sort%3Aupdated-desc) and we'll try to make sure that your questions get answered here in the future!

## Code

Browsertrix Crawler is free and open source software, with all code available in the [main repository on Github](https://github.com/webrecorder/browsertrix-crawler).
