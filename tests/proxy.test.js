import { execSync, exec, spawnSync } from "child_process";

import { getSafeProxyString } from "../dist/util/proxy.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const PROXY_IMAGE = "tarampampam/3proxy:1.9.1";
const SOCKS_PORT = "1080";
const HTTP_PORT = "3128";
const WRONG_PORT = "33130";

const PROXY_EXIT_CODE = 21;

const SSH_PROXY_IMAGE = "linuxserver/openssh-server"

const PDF = "https://specs.webrecorder.net/wacz/1.1.1/wacz-2021.pdf";
const HTML = "https://old.webrecorder.net/";

const extraArgs = "--limit 1 --failOnFailedSeed --timeout 10 --logging debug";

let proxyAuthId;
let proxyNoAuthId;
let proxySSHId;

beforeAll(() => {
  execSync("docker network create proxy-test-net");

  proxyAuthId = execSync(`docker run -e PROXY_LOGIN=user -e PROXY_PASSWORD=passw0rd -d --rm --network=proxy-test-net --name proxy-with-auth ${PROXY_IMAGE}`, {encoding: "utf-8"});

  proxyNoAuthId = execSync(`docker run -d --rm --network=proxy-test-net --name proxy-no-auth ${PROXY_IMAGE}`, {encoding: "utf-8"});

  proxySSHId = execSync(`docker run -d --rm -e DOCKER_MODS=linuxserver/mods:openssh-server-ssh-tunnel -e USER_NAME=user -e PUBLIC_KEY_FILE=/keys/proxy-key.pub -v $PWD/tests/fixtures/proxies/proxy-key.pub:/keys/proxy-key.pub --network=proxy-test-net --name ssh-proxy ${SSH_PROXY_IMAGE}`);
});

afterAll(async () => {
  execSync(`docker kill -s SIGINT ${proxyAuthId}`);
  execSync(`docker kill -s SIGINT ${proxyNoAuthId}`);
  execSync(`docker kill -s SIGINT ${proxySSHId}`);

  spawnSync(`docker wait ${proxyAuthId}`);
  spawnSync(`docker wait ${proxyNoAuthId}`);
  spawnSync(`docker wait ${proxySSHId}`);

  execSync("docker network rm proxy-test-net");
});

describe("socks5 + https proxy tests", () => {
  for (const scheme of ["socks5", "http"]) {
    const port = scheme === "socks5" ? SOCKS_PORT : HTTP_PORT;

    for (const type of ["HTML page", "PDF"]) {

      const url = type === "PDF" ? PDF : HTML;

      test(`${scheme} proxy, ${type}, no auth`, () => {
        let status = 0;

        try {
          execSync(`docker run -e PROXY_SERVER=${scheme}://proxy-no-auth:${port} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        }
        expect(status).toBe(0);
      });

      test(`${scheme} proxy, ${type}, with auth`, () => {
        let status = 0;

        try {
          execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@proxy-with-auth:${port} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        }
        // auth supported only for SOCKS5
        expect(status).toBe(scheme === "socks5" ? 0 : PROXY_EXIT_CODE);
      });

      test(`${scheme} proxy, ${type}, wrong auth`, () => {
        let status = 0;

        try {
          execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw1rd@proxy-with-auth:${port} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        }
        expect(status).toBe(PROXY_EXIT_CODE);
      });

      test(`${scheme} proxy, ${type}, wrong protocol`, () => {
        let status = 0;

        try {
          execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw1rd@proxy-with-auth:${scheme === "socks5" ? HTTP_PORT : SOCKS_PORT} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        }
        // wrong protocol (socks5 for http) causes connection to hang, causes a timeout, so just errors with 1
        expect(status === PROXY_EXIT_CODE || status === 1).toBe(true);
      });
    }

    test(`${scheme} proxy, proxy missing error`, () => {
      let status = 0;

      try {
        execSync(`docker run -e PROXY_SERVER=${scheme}://proxy-no-auth:${WRONG_PORT} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
      } catch (e) {
        status = e.status;
      }
      expect(status).toBe(PROXY_EXIT_CODE);
    });
  }
});


test("http proxy, PDF, separate env vars", () => {
  execSync(`docker run -e PROXY_HOST=proxy-no-auth -e PROXY_PORT=${HTTP_PORT} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
});

test("http proxy set, but not running, separate env vars", () => {
  let status = 0;

  try {
    execSync(`docker run -e PROXY_HOST=proxy-no-auth -e PROXY_PORT=${WRONG_PORT} --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(PROXY_EXIT_CODE);
});

test("http proxy set, but not running, cli arg", () => {
  let status = 0;

  try {
    execSync(`docker run --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --proxyServer http://proxy-no-auth:${WRONG_PORT} --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(PROXY_EXIT_CODE);
});


test("ssh socks proxy with custom user", () => {
  execSync(`docker run --rm --network=proxy-test-net -v $PWD/tests/fixtures/proxies/proxy-key:/keys/proxy-key webrecorder/browsertrix-crawler crawl --proxyServer ssh://user@ssh-proxy:2222 --sshProxyPrivateKeyFile /keys/proxy-key --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
});


test("ssh socks proxy, wrong user", () => {
  let status = 0;

  try {
    execSync(`docker run --rm --network=proxy-test-net webrecorder/browsertrix-crawler crawl --proxyServer ssh://ssh-proxy:2222 --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(PROXY_EXIT_CODE);
});


test("ensure logged proxy string does not include any credentials", () => {
  const testParams = [
    // [input, expectedOutput]
    ["socks5://username:password@proxy-host.example.com:9001", "socks5://proxy-host.example.com:9001"],
    ["socks5://username@proxy-host.example.com:9001", "socks5://proxy-host.example.com:9001"],
    ["socks5://path-to-proxy-host.example.com:9001", "socks5://path-to-proxy-host.example.com:9001"],
    ["ssh://localhost:9700", "ssh://localhost:9700"]
  ];
  for (const testParamSet of testParams) {
    expect(getSafeProxyString(testParamSet[0])).toEqual(testParamSet[1]);
  }
});


test("proxy with config file, wrong auth or no match", () => {
  let status = 0;
  try {
    execSync(`docker run --rm --network=proxy-test-net -v $PWD/tests/fixtures/proxies/:/proxies/ webrecorder/browsertrix-crawler crawl --proxyServerConfig /proxies/proxy-test-bad-auth.pac --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(PROXY_EXIT_CODE);

  // success, no match for PDF
  execSync(`docker run --rm --network=proxy-test-net -v $PWD/tests/fixtures/proxies/:/proxies/ webrecorder/browsertrix-crawler crawl --proxyServerConfig /proxies/proxy-test-bad-auth.pac --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
});


test("proxy with config file, correct auth or no match", () => {
  let status = 0;
  try {
    execSync(`docker run --rm --network=proxy-test-net -v $PWD/tests/fixtures/proxies/:/proxies/ webrecorder/browsertrix-crawler crawl --proxyServerConfig /proxies/proxy-test-good-auth.pac --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(0);

  // success, no match for PDF
  execSync(`docker run --rm --network=proxy-test-net -v $PWD/tests/fixtures/proxies/:/proxies/ webrecorder/browsertrix-crawler crawl --proxyServerConfig /proxies/proxy-test-good-auth.pac --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});

});
