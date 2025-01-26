import net from "net";
import { Agent, Dispatcher, ProxyAgent } from "undici";

import child_process from "child_process";

import { logger } from "./logger.js";

import { socksDispatcher } from "fetch-socks";
import type { SocksProxyType } from "socks/typings/common/constants.js";
import { FETCH_HEADERS_TIMEOUT_SECS } from "./constants.js";

const SSH_PROXY_LOCAL_PORT = 9722;

const SSH_WAIT_TIMEOUT = 30000;

let proxyDispatcher: Dispatcher | undefined = undefined;

export function getEnvProxyUrl() {
  if (process.env.PROXY_SERVER) {
    return process.env.PROXY_SERVER;
  }

  // for backwards compatibility with 0.x proxy settings
  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    return `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
  }

  return "";
}

export async function initProxy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  detached: boolean,
): Promise<string | undefined> {
  let proxy = params.proxyServer;

  if (!proxy) {
    proxy = getEnvProxyUrl();
  }
  if (proxy && proxy.startsWith("ssh://")) {
    proxy = await runSSHD(params, detached);
  }

  const agentOpts: Agent.Options = {
    headersTimeout: FETCH_HEADERS_TIMEOUT_SECS * 1000,
  };

  // set global fetch() dispatcher (with proxy, if any)
  const dispatcher = createDispatcher(proxy, agentOpts);
  proxyDispatcher = dispatcher;
  return proxy;
}

export function getProxyDispatcher() {
  return proxyDispatcher;
}

export function createDispatcher(
  proxyUrl: string,
  opts: Agent.Options,
): Dispatcher {
  if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
    // HTTP PROXY does not support auth, as it's not supported in the browser
    // so must drop username/password for consistency
    const url = new URL(proxyUrl);
    url.username = "";
    url.password = "";
    return new ProxyAgent({ uri: url.href, ...opts });
  } else if (
    proxyUrl.startsWith("socks://") ||
    proxyUrl.startsWith("socks5://") ||
    proxyUrl.startsWith("socks4://")
  ) {
    // SOCKS5 auth *is* supported in Brave (though not in Chromium)
    const url = new URL(proxyUrl);
    const type: SocksProxyType = url.protocol === "socks4:" ? 4 : 5;
    const params = {
      type,
      host: url.hostname,
      port: parseInt(url.port),
      userId: url.username || undefined,
      password: url.password || undefined,
    };
    return socksDispatcher(params, { ...opts, connect: undefined });
  } else {
    return new Agent(opts);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runSSHD(params: Record<string, any>, detached: boolean) {
  const { proxyServer } = params;
  if (!proxyServer || !proxyServer.startsWith("ssh://")) {
    return "";
  }

  const proxyServerUrl = new URL(proxyServer);

  // unwrap ipv6 addresses which must be wrapped in []
  const host = proxyServerUrl.hostname.replace("[", "").replace("]", "");
  const port = proxyServerUrl.port || 22;
  const user = proxyServerUrl.username || "root";
  const localPort = params.sshProxyLocalPort || SSH_PROXY_LOCAL_PORT;
  const proxyString = `socks5://localhost:${localPort}`;

  const args: string[] = [
    user + "@" + host,
    "-p",
    port,
    "-D",
    localPort,
    "-i",
    params.sshProxyPrivateKeyFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ServerAliveInterval=10", // keep ssh connection open if it becomes inactive
    "-o",
    "ExitOnForwardFailure=yes", // exit ssh when it's unable to open a socks proxy port
    "-o",
  ];

  if (params.sshProxyKnownHostsFile) {
    args.push(`UserKnownHostsFile=${params.sshProxyKnownHostsFile}`);
  } else {
    args.push("StrictHostKeyChecking=no");
  }

  args.push("-M", "0", "-N", "-T");

  logger.info("Checking SSH connection for proxy...", {}, "proxy");
  logger.debug("SSH Command: autossh " + args.join(" "), {}, "proxy");

  const proc = child_process.spawn("autossh", args, { detached });

  let procStdout = "";
  let procStderr = "";
  proc.stdout.on("data", (data) => {
    procStdout += data.toString();
    logger.debug("Proxy Stdout: " + data.toString(), {}, "proxy");
  });
  proc.stderr.on("data", (data) => {
    procStderr += data.toString();
    logger.debug("Proxy Stderr: " + data.toString(), {}, "proxy");
  });

  const timeout = SSH_WAIT_TIMEOUT;
  const waitForSocksPort = new Promise((resolve, reject) => {
    const startTime = Date.now();
    function rejectOrRetry() {
      if (Date.now() - startTime >= timeout) {
        reject("Timeout reached");
      } else {
        logger.debug("Retrying connection to SSH proxy port", {}, "proxy");
        setTimeout(testPort, 500);
      }
    }
    function testPort() {
      if (proc.exitCode) {
        reject("Process failed");
      }
      const conn = net
        .connect(localPort, "localhost")
        .on("error", () => {
          rejectOrRetry();
        })
        .on("timeout", () => {
          conn.end();
          rejectOrRetry();
        })
        .on("connect", () => {
          conn.end();
          resolve(true);
        });
      const timeRemaining = timeout - (Date.now() - startTime);
      if (timeRemaining <= 0) {
        reject("Timeout reached");
      } else {
        conn.setTimeout(timeRemaining);
      }
    }
    testPort();
  });
  try {
    await waitForSocksPort;
  } catch (e) {
    logger.fatal(
      "Unable to establish SSH connection for proxy",
      {
        error: e,
        stdout: procStdout,
        stderr: procStderr,
        code: proc.exitCode,
      },
      "proxy",
      21,
    );
    return;
  }

  logger.info(
    `Established SSH tunnel for proxy ${proxyString} -> ${proxyServer}`,
    {},
    "proxy",
  );

  proc.on("exit", (code, signal) => {
    logger.warn(
      `SSH crashed, restarting`,
      {
        code,
        signal,
        stdout: procStdout,
        stderr: procStderr,
      },
      "proxy",
    );
    runSSHD(params, detached).catch((e) =>
      logger.error("proxy retry error", e, "proxy"),
    );
  });

  return proxyString;
}
