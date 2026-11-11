# Building and running outside the Docker image

The supported deployment is the Docker image, which bundles the browser,
Xvfb, redis-server and several static assets. This page documents the
implicit dependencies that the `Dockerfile` and the
`webrecorder/browsertrix-browser-base` base image provide, so that the
crawler can also be built and run directly from the source tree (for
example during development). No runtime behavior inside the container is
affected.

## Build

`yarn install --frozen-lockfile` followed by `yarn run tsc` produces the
ESM output in `dist/`. There is no native binary step: the `crawl`
command shown in the Docker docs is a symlink to `dist/main.js`, and the
QA entry point is selected by the `qa` suffix on `argv[1]`.

## ReplayWeb.page static assets

`src/util/replayserver.ts` reads four files at module load:

- `html/replay.html`
- `html/rwp/ui.js`
- `html/rwp/sw.js`
- `html/rwp/adblock.gz`

Inside the image these are fetched from the CDN by the `Dockerfile`
(see `ARG RWP_VERSION` and the `ADD https://cdn.jsdelivr.net/npm/replaywebpage/...`
lines). When building outside the image, download the matching
`replaywebpage` version's `ui.js`, `sw.js` and `adblock/adblock.gz`
into `html/rwp/` before starting the crawler.

## Environment variables normally set by the image

- `GEOMETRY` — required. The `Browser` constructor fails without it.
  Format `WxHxD`, e.g. `1360x1020x16`.
- `BROWSER_BIN` — path to a Chromium-family browser executable. If
  unset, `/usr/bin/google-chrome` and `/usr/bin/chromium-browser` are
  tried; on other platforms set `BROWSER_BIN` explicitly.
- `DETACHED_CHILD_PROC` — set to `1` in the image (PID-1 child reaping).

## redis-server

Crawl state is stored in Redis: `--redisStoreUrl` must be a `redis://`
URL (default `redis://localhost:6379/0`) and there is no in-memory
fallback. For localhost URLs the crawler spawns `redis-server` itself,
so a real `redis-server` binary must be on `PATH`; for remote URLs a
reachable Redis instance is required. A stub RESP server is not
sufficient — `src/util/state.ts` defines custom commands via Lua
(`EVAL`).

## ad-hosts.json

`--blockAds` reads `ad-hosts.json` from the package root (generated in
the image from the StevenBlack hosts list). Without the flag the file is
not required.

## Other defaults worth knowing

- `--cwd` defaults to `process.cwd()`; collections are written to
  `<cwd>/collections/<collection>/`.
- The headless flag is recommended outside the image, where Xvfb is not
  started automatically.
