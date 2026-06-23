# AGENTS.md

Browsertrix Crawler is a Docker-based browser crawling system using Puppeteer + Brave Browser over CDP. This is the [Transparency Hub fork](https://github.com/berkmancenter/browsertrix-crawler-thub-fork) of [webrecorder/browsertrix-crawler](https://github.com/webrecorder/browsertrix-crawler). Language: TypeScript. Package manager: Yarn.

## Setup

```bash
yarn install
yarn tsc           # compile TypeScript → build/
```

## Build & Test

```bash
# Fast feedback — run a single test file:
yarn node --experimental-vm-modules $(yarn bin jest) tests/basic_crawl.test.js

# Full suite:
yarn test

# Lint + format (must pass before committing):
yarn lint
yarn format
yarn lint:fix      # auto-fix
yarn format:fix    # auto-fix
```

## Project Structure

```
src/          TypeScript source (crawler.ts, main.ts, util/)
tests/        Jest test files (*.test.js)
docs/         Documentation
Dockerfile    Container definition
```

## Code Conventions

- All source code is TypeScript; no plain `.js` in `src/`
- Prefer: `await page.waitForSelector(selector)` over arbitrary `sleep()` delays
- Avoid: importing from `build/` directly in source; always import from `src/`
- Add a test in `tests/` for any new crawl behavior

## Permissions

**Do without approval:**
- Read any file, list directories
- Run `yarn lint`, `yarn format`, `yarn tsc`
- Run a single test file

**Ask before doing:**
- `yarn install` or adding/removing packages
- Running the full test suite (`yarn test`) — it spins up Docker containers
- Any `git commit`, `git push`, or branch operations
- Modifying `Dockerfile` or `docker-compose.yml`
- Deleting files

## Notes

- Do not hardcode credentials, URLs, or tokens anywhere in source or tests — use environment variables
- This file should be updated in PRs when processes change; see [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines
