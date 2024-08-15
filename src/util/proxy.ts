import net from "net";
import { Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

import child_process from "child_process";

import { logger } from "./logger.js";

import { socksDispatcher } from "fetch-socks";
import type { SocksProxyType } from "socks/typings/common/constants.js";

const SSH_PROXY_LOCAL_PORT = 9722;

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
) {
  let proxy = params.proxyServer;

  if (!proxy) {
    proxy = getEnvProxyUrl();
  }
  if (proxy && proxy.startsWith("ssh://")) {
    proxy = await runSSHD(params, detached);
  }
  if (proxy) {
    const dispatcher = createDispatcher(proxy);
    if (dispatcher) {
      setGlobalDispatcher(dispatcher);
      return proxy;
    }
  }
  return "";
}

export function createDispatcher(proxyUrl: string): Dispatcher | undefined {
  if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
    // HTTP PROXY does not support auth, as it's not supported in the browser
    // so must drop username/password for consistency
    const url = new URL(proxyUrl);
    url.username = "";
    url.password = "";
    return new ProxyAgent({ uri: url.href });
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
    return socksDispatcher(params);
  } else {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runSSHD(params: Record<string, any>, detached: boolean) {
  const { proxyServer } = params;
  if (!proxyServer || !proxyServer.startsWith("ssh://")) {
    return "";
  }

  const hostPort = proxyServer.slice(6).split(":");
  const host = hostPort[0];
  const port = hostPort.length > 1 ? hostPort[1] : 22;
  const localPort = params.sshProxyLocalPort || SSH_PROXY_LOCAL_PORT;
  const proxyString = `socks5://localhost:${localPort}`;

  const coreArgs: string[] = [
    host,
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
    coreArgs.push(`UserKnownHostsFile=${params.sshProxyKnownHostsFile}`);
  } else {
    coreArgs.push("StrictHostKeyChecking=no");
  }

  logger.info("Checking SSH connection for proxy...");

  const proc = child_process.spawn(
    "autossh",
    [...coreArgs, "-M", "0", "-N", "-T"],
    {
      detached,
    },
  );

  let procStdout = "";
  let procStderr = "";
  proc.stdout.on("data", (data) => {
    procStdout += data.toString();
    logger.info(data.toString());
  });
  proc.stderr.on("data", (data) => {
    procStderr += data.toString();
    logger.info(data.toString());
  });

  const timeout = 5000;
  const waitForSocksPort = new Promise((resolve, reject) => {
    const startTime = Date.now();
    function rejectOrRetry() {
      if (Date.now() - startTime >= timeout) {
        reject("Timeout reached");
      } else {
        logger.warn("Retrying connection to socks proxy port");
        setTimeout(testPort, 250);
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
      "general",
      21,
    );
    return;
  }

  logger.info(
    `Established SSH tunnel for proxy ${proxyString} -> ${proxyServer}`,
  );

  proc.on("exit", (code, signal) => {
    logger.warn(`SSH crashed, restarting`, {
      code,
      signal,
      stdout: procStdout,
      stderr: procStderr,
    });
    runSSHD(params, detached);
  });

  return proxyString;
}
