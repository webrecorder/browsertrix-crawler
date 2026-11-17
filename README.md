# Browsertrix Crawler 1.x

Browsertrix Crawler is a standalone browser-based high-fidelity crawling system, designed to run a complex, customizable browser-based crawl in a single Docker container. Browsertrix Crawler uses [Puppeteer](https://github.com/puppeteer/puppeteer) to control one or more [Brave Browser](https://brave.com/) browser windows in parallel. Data is captured through the [Chrome Devtools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/) in the browser.

For information on how to use and develop Browsertrix Crawler, see the hosted [Browsertrix Crawler documentation](https://crawler.docs.browsertrix.com).

For information on how to build the docs locally, see the [docs page](docs/docs/develop/docs.md).

## Agent-assisted crawling example

This branch adds a custom behavior for pages where normal crawling may be blocked by an interactive gate. At a high level, the behavior checks whether agent assistance is needed, requests suggested actions from a local listener, executes those actions, and then reevaluates the page. Without the custom behavior, a crawl of the included age-gate examples captures only the gate; with it enabled, the crawler can reach and capture the content behind the gate.

The example seeds are listed in `crawl-config.yaml`. First, start the local listener from the repository root:

```sh
python listener.py
```

Then, in another terminal, run the crawler using this command format:

```sh
docker run --rm \
  -v "$PWD/crawl-config.yaml:/app/crawl-config.yaml:ro" \
  -v "$PWD/crawls:/crawls" \
  -v "$PWD/crawls/agent_support.js:/custom-behaviors/agent_support.js:ro" \
  webrecorder/browsertrix-crawler crawl \
  --config /app/crawl-config.yaml \
  --customBehaviors /custom-behaviors/agent_support.js \
  --limit 51 --depth 1 --workers 1 \
  --collection agent-example --generateWACZ
```

Run this command from the repository root so `$PWD` points to the correct files. `dkr_cmd.txt` provides an executable example that resolves the repository location automatically. The listener expects the Codex CLI to be installed and authenticated on the host.


## Support
Initial support for 0.x version of Browsertrix Crawler, was provided by [Kiwix](https://kiwix.org/). The initial functionality for Browsertrix Crawler was developed to support the [zimit](https://github.com/openzim/zimit) project in a collaboration between Webrecorder and Kiwix, and this project has been split off from Zimit into a core component of Webrecorder.

Additional support for Browsertrix Crawler, including for the development of the 0.4.x version has been provided by [Portico](https://www.portico.org/).

## License

[AGPLv3](https://www.gnu.org/licenses/agpl-3.0) or later, see [LICENSE](LICENSE) for more details.
