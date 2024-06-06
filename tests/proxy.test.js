import child_process from "child_process";

let globalPort = 33080;

const PROXY_IMAGE = "tarampampam/3proxy:1.9.1";

const PDF = "https://specs.webrecorder.net/wacz/1.1.1/wacz-2021.pdf";
const HTML = "https://webrecorder.net/";

const extraArgs = "--limit 1 --failOnFailedSeed --timeout 10 --logging debug";

function killContainer(id) {
  child_process.execSync(`docker kill -s SIGINT ${id}`);
}

function runSocksProxy(scheme, user="", pass="") {
  const isSocks = scheme === "socks5";
  const port = globalPort;
  const id = child_process.execSync(`docker run -e PROXY_LOGIN=${user} -e PROXY_PASSWORD=${pass} -d --rm -p ${globalPort++}:${isSocks ? "1080" : "3128"} ${PROXY_IMAGE}`, {encoding: "utf-8"});
  return {id, port};
}

describe("socks5 + https proxy tests", () => {
  for (const scheme of ["socks5", "http"]) {
    for (const type of ["HTML page", "PDF"]) {

      const url = type === "PDF" ? PDF : HTML;

      test(`${scheme} proxy, ${type}, no auth`, () => {
        const {id, port} = runSocksProxy(scheme);
        let status = 0;

        try {
          child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://host.docker.internal:${port} --rm webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        } finally {
          killContainer(id);
        }
        expect(status).toBe(0);
      });

      test(`${scheme} proxy, ${type}, with auth`, () => {
        const {id, port} = runSocksProxy(scheme, "user", "passw0rd");
        let status = 0;

        try {
          child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@host.docker.internal:${port} --rm webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        } finally {
          killContainer(id);
        }
        // auth supported only for SOCKS5
        expect(status).toBe(scheme === "socks5" ? 0 : 1);
      });

      test(`${scheme} proxy, ${type}, wrong auth`, () => {
        const {id, port} = runSocksProxy(scheme, "user", "passw1rd");
        let status = 0;

        try {
          child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@host.docker.internal:${port} --rm webrecorder/browsertrix-crawler crawl --url ${url} ${extraArgs}`, {encoding: "utf-8"});
        } catch (e) {
          status = e.status;
        } finally {
          killContainer(id);
        }
        expect(status).toBe(1);
      });
    }

    test(`${scheme} proxy, proxy missing error`, () => {
      let status = 0;

      try {
        child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://host.docker.internal:${++globalPort} --rm webrecorder/browsertrix-crawler crawl --url ${HTML} ${extraArgs}`, {encoding: "utf-8"});
      } catch (e) {
        status = e.status;
      }
      expect(status).toBe(1);
    });
  }
});


test("http proxy, PDF, separate env vars", () => {
  const {id, port} = runSocksProxy("http");

  try {
    child_process.execSync(`docker run -e PROXY_HOST=host.docker.internal -e PROXY_PORT=${port} --rm webrecorder/browsertrix-crawler crawl --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
  } finally {
    killContainer(id);
  }
});

test("http proxy, error, not running, separate env vars", () => {
  let status = 0;

  try {
    child_process.execSync(`docker run -e PROXY_HOST=host.docker.internal -e PROXY_PORT=${++globalPort} --rm webrecorder/browsertrix-crawler crawl --url ${PDF} ${extraArgs}`, {encoding: "utf-8"});
  } catch (e) {
    status = e.status;
  }
  expect(status).toBe(1);
});


