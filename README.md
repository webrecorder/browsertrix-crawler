# Browsertrix Crawler - Transparency Hub Fork 1.x

> **Note**: This is a fork of [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler) maintained by the Berkman Klein Center for Internet & Society at Harvard University. For the original project, please visit the [upstream repository](https://github.com/webrecorder/browsertrix-crawler).

Browsertrix Crawler is a standalone browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [Puppeteer](https://github.com/puppeteer/puppeteer) to control one or more [Brave Browser](https://brave.com/) browser windows in parallel. Data is captured through the [Chrome Devtools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) in the browser.

For information on how to use and develop Browsertrix Crawler, see the hosted [Browsertrix Crawler documentation](https://crawler.docs.browsertrix.com).

For information on how to build the docs locally, see the [docs page](docs/docs/develop/docs.md).


## Support
Initial support for 0.x version of Browsertrix Crawler, was provided by [Kiwix](https://kiwix.org/). The initial functionality for Browsertrix Crawler was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.

Additional support for Browsertrix Crawler, including for the development of the 0.4.x version has been provided by [Portico](https://www.portico.org/).

## Related Repositories

This fork is part of the Transparency Hub ecosystem maintained by the Berkman Klein Center for Internet & Society at Harvard University:

| Repository | Description |
|-----------|-------------|
| **[Transparency Hub](https://github.com/berkmancenter/transparency-hub)** | Next.js frontend — the public-facing website |
| **[Transparency Archiver](https://github.com/berkmancenter/transparency-hub-engine)** | Python pipeline that uses this crawler to archive policy documents |
| **[Browsertrix Crawler Fork](https://github.com/berkmancenter/browsertrix-crawler-thub-fork)** (this repo) | Custom fork of Browsertrix Crawler |

## License

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see [LICENSE](LICENSE) for more details.
