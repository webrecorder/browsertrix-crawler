import child_process from "child_process";

let port = 33080;

const PROXY_IMAGE = "ghcr.io/tarampampam/3proxy:1.9.1"

function runSocksProxy(scheme, user="", pass="") {
  const isSocks = scheme === "socks5";
  const id = child_process.execSync(`docker run -d --rm -e PROXY_USER=${user} -e PROXY_PASSWORD=${pass} -p ${port++}:${isSocks ? "1080" : "3128"} ${PROXY_IMAGE}`, {encoding: "utf-8"});
  return {id, port};
}

describe("socks5 + https proxy tests", () => {
  for (const mode of ["socks5", "http"]) {
    const scheme = mode;

    test(`${scheme} proxy, no auth`, async () => {
      const {id, port} = runSocksProxy(mode);
      const result = child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://host.docker.internal:${port} -d --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --limit 1 --logging debug`, {encoding: "utf-8"});

      child_process.execSync(`docker kill -s SIGINT ${id}`);

      expect(!!result).toBe(true);
    });

    test(`${scheme} proxy, with auth`, async () => {
      const {id, port} = runSocksProxy(mode, "user", "passw0rd");
      const result = child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@host.docker.internal:${port} -d --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --limit 1 --logging debug`, {encoding: "utf-8"});

      child_process.execSync(`docker kill -s SIGINT ${id}`);

      expect(!!result).toBe(true);
    });

    test(`${scheme} proxy, error, not running`, async () => {
      let status = 0;

      try {
        child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@host.docker.internal:${port} --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --limit 1 --failOnFailedSeed`, {encoding: "utf-8"});
      } catch (e) {
        status = e.status;
      }
      expect(status).toBe(1);
    });

    test(`${scheme} proxy, error, wrong auth`, async () => {
      const {id, port} = runSocksProxy(mode, "user", "passw1rd");

      let status = 0;

      try {
        child_process.execSync(`docker run -e PROXY_SERVER=${scheme}://user:passw0rd@host.docker.internal:${port} --rm webrecorder/browsertrix-crawler crawl --url https://example.com/ --limit 1 --failOnFailedSeed --timeout 10`, {encoding: "utf-8"});
      } catch (e) {
        status = e.status;
      }
      expect(status).toBe(1);

      child_process.execSync(`docker kill -s SIGINT ${id}`);
    });
  }
});
