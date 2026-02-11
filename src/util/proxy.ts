import net from "net";
import child_process from "child_process";
import fs from "fs";

import { Agent, Dispatcher, interceptors, ProxyAgent } from "undici";
import yaml from "js-yaml";

import { logger } from "./logger.js";

import { socksDispatcher } from "fetch-socks";
import type { SocksProxyType } from "socks/typings/common/constants.js";
import { ExitCodes, FETCH_HEADERS_TIMEOUT_SECS } from "./constants.js";

import http, { IncomingMessage, ServerResponse } from "http";

const SSH_PROXY_LOCAL_PORT = 9722;

const SSH_WAIT_TIMEOUT = 30000;

type ProxyEntry = {
  proxyUrl: string;
  dispatcher: Dispatcher;
  redirectDispatcher: Dispatcher;
};

// Opts for all requests
const baseOpts: Agent.Options = {
  headersTimeout: FETCH_HEADERS_TIMEOUT_SECS * 1000,

  // allow HTTP/2 connections
  allowH2: true,
};

// Opts for all archival content requests
const contentAgentOpts: Agent.Options = {
  ...baseOpts,

  // ignore invalid SSL certs (matches browser settings)
  connect: {
    rejectUnauthorized: false,
  },
};

// dispatcher for archival content without following redirects
const contentDispatcher = addDecompressInterceptor(new Agent(contentAgentOpts));

// dispatcher for archival content with following redirects
const contentRedirectDispatcher = addRedirectInterceptor(contentDispatcher);

// dispatcher for following redirects, non-archival content, trust SSL
const followRedirectDispatcher = addRedirectInterceptor(
  addDecompressInterceptor(new Agent(baseOpts)),
);

export type ProxyServerConfig = {
  matchHosts?: Record<string, string>;
  proxies?: Record<
    string,
    string | { url: string; privateKeyFile?: string; publicHostsFile?: string }
  >;
};

export type ProxyCLIArgs = {
  sshProxyPrivateKeyFile?: string;
  sshProxyKnownHostsFile?: string;
  sshProxyLocalPort?: number;

  proxyServer?: string;
  proxyServerPreferSingleProxy?: boolean;

  proxyMap?: ProxyServerConfig;
};

const proxyMap = new Map<RegExp, ProxyEntry>();
let defaultProxyEntry: ProxyEntry | null = null;

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

export function loadProxyConfig(params: {
  proxyServerConfig?: string;
  proxyMap?: ProxyServerConfig;
}) {
  if (params.proxyServerConfig) {
    const proxyServerConfig = params.proxyServerConfig;
    try {
      const proxies = yaml.load(
        fs.readFileSync(proxyServerConfig, "utf8"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;
      params.proxyMap = proxies;
      logger.debug("Proxy host match config loaded", { proxyServerConfig });
    } catch (e) {
      logger.warn("Proxy host match config file not found, ignoring", {
        proxyServerConfig,
      });
    }
  }
}

export function getSafeProxyString(proxyString: string): string {
  if (!proxyString) {
    return "";
  }

  try {
    const proxySplit = proxyString.split("://");
    const prefix = proxySplit[0];
    const remainder = proxySplit[1];

    const credSplit = remainder.split("@");

    let addressIndex = 1;
    if (credSplit.length === 1) {
      addressIndex = 0;
    }

    const addressNoCredentials = credSplit[addressIndex];

    return `${prefix}://${addressNoCredentials}`;
  } catch (e) {
    return "";
  }
}

export async function initProxy(
  params: ProxyCLIArgs,
  detached: boolean,
): Promise<{ proxyServer?: string; proxyPacUrl?: string }> {
  const { sshProxyPrivateKeyFile, sshProxyKnownHostsFile, sshProxyLocalPort } =
    params;
  let localPort = sshProxyLocalPort || SSH_PROXY_LOCAL_PORT;

  const singleProxy = params.proxyServer || getEnvProxyUrl();

  if (singleProxy) {
    defaultProxyEntry = await initSingleProxy(
      singleProxy,
      localPort++,
      detached,
      sshProxyPrivateKeyFile,
      sshProxyKnownHostsFile,
    );
    if (params.proxyServerPreferSingleProxy && defaultProxyEntry.proxyUrl) {
      return { proxyServer: defaultProxyEntry.proxyUrl };
    }
  }

  if (!params.proxyMap?.matchHosts || !params.proxyMap?.proxies) {
    if (defaultProxyEntry) {
      logger.debug("Using Single Proxy", {}, "proxy");
    }
    return { proxyServer: defaultProxyEntry?.proxyUrl };
  }

  const nameToProxy = new Map<string, ProxyEntry>();

  for (const [name, value] of Object.entries(params.proxyMap.proxies)) {
    let proxyUrl = "";
    let privateKeyFile: string | undefined = "";
    let publicHostsFile: string | undefined = "";

    if (typeof value === "string") {
      proxyUrl = value;
    } else {
      proxyUrl = value.url;
      privateKeyFile = value.privateKeyFile;
      publicHostsFile = value.publicHostsFile;
    }

    privateKeyFile = privateKeyFile || sshProxyPrivateKeyFile;
    publicHostsFile = publicHostsFile || sshProxyKnownHostsFile;

    const entry = await initSingleProxy(
      proxyUrl,
      localPort++,
      detached,
      privateKeyFile,
      publicHostsFile,
    );

    nameToProxy.set(name, entry);
  }

  for (const [rx, name] of Object.entries(params.proxyMap.matchHosts)) {
    const entry = nameToProxy.get(name);

    if (!entry) {
      logger.fatal("Proxy specified but not found in proxies list: " + name);
      return {};
    }

    if (rx) {
      proxyMap.set(new RegExp(rx), entry);
    } else {
      defaultProxyEntry = entry;
    }
  }

  const p = new ProxyPacServer();

  logger.debug("Using Proxy PAC script", {}, "proxy");

  return { proxyPacUrl: `http://localhost:${p.port}/proxy.pac` };
}

export async function initSingleProxy(
  proxyUrl: string,
  localPort: number,
  detached: boolean,
  sshProxyPrivateKeyFile?: string,
  sshProxyKnownHostsFile?: string,
): Promise<ProxyEntry> {
  logger.debug("Initing proxy", {
    url: getSafeProxyString(proxyUrl),
    localPort,
    sshProxyPrivateKeyFile,
    sshProxyKnownHostsFile,
  });

  if (proxyUrl && proxyUrl.startsWith("ssh://")) {
    proxyUrl = await runSSHD(
      proxyUrl,
      localPort,
      detached,
      sshProxyPrivateKeyFile,
      sshProxyKnownHostsFile,
    );
  }

  const dispatcher = addDecompressInterceptor(
    createDispatcher(proxyUrl, contentAgentOpts),
  );
  const redirectDispatcher = addRedirectInterceptor(dispatcher);
  return { proxyUrl, dispatcher, redirectDispatcher };
}

export function addRedirectInterceptor(dispatcher: Dispatcher) {
  // match fetch() max redirects if not doing manual redirects
  // https://fetch.spec.whatwg.org/#http-redirect-fetch
  const redirector = interceptors.redirect({ maxRedirections: 20 });
  return dispatcher.compose(redirector);
}

export function addDecompressInterceptor(dispatcher: Dispatcher) {
  const decompress = interceptors.decompress();
  return dispatcher.compose(decompress);
}

export function getProxyDispatcher(url: string, withRedirect = true) {
  // find url match by regex first
  for (const [rx, { dispatcher, redirectDispatcher }] of proxyMap.entries()) {
    if (rx && url.match(rx)) {
      return withRedirect ? redirectDispatcher : dispatcher;
    }
  }

  // if default proxy set, return dispatcher from default proxy, otherwise a default dispatcher
  if (defaultProxyEntry) {
    return withRedirect
      ? defaultProxyEntry.redirectDispatcher
      : defaultProxyEntry.dispatcher;
  } else {
    return withRedirect ? contentRedirectDispatcher : contentDispatcher;
  }
}

export function getFollowRedirectDispatcher() {
  return followRedirectDispatcher;
}

function createDispatcher(proxyUrl: string, opts: Agent.Options): Dispatcher {
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

export async function runSSHD(
  proxyServer: string,
  localPort: number,
  detached: boolean,
  privateKey?: string,
  publicKnownHost?: string,
) {
  if (!proxyServer || !proxyServer.startsWith("ssh://")) {
    return "";
  }

  const proxyServerUrl = new URL(proxyServer);

  // unwrap ipv6 addresses which must be wrapped in []
  const host = proxyServerUrl.hostname.replace("[", "").replace("]", "");
  const port = proxyServerUrl.port || 22;
  const user = proxyServerUrl.username || "root";
  const proxyString = `socks5://localhost:${localPort}`;

  const args: string[] = [
    user + "@" + host,
    "-p",
    port + "",
    "-D",
    localPort + "",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ServerAliveInterval=10", // keep ssh connection open if it becomes inactive
    "-o",
    "ExitOnForwardFailure=yes", // exit ssh when it's unable to open a socks proxy port
    "-o",
  ];

  if (publicKnownHost) {
    args.push(`UserKnownHostsFile=${publicKnownHost}`);
  } else {
    args.push("StrictHostKeyChecking=no");
  }

  if (privateKey) {
    args.push("-i");
    args.push(privateKey);
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
      ExitCodes.ProxyError,
    );
    return "";
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
    runSSHD(
      proxyServer,
      localPort,
      detached,
      privateKey,
      publicKnownHost,
    ).catch((e) => logger.error("proxy retry error", e, "proxy"));
  });

  return proxyString;
}

class ProxyPacServer {
  port = 20278;

  proxyPacText = "";

  constructor() {
    const httpServer = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    httpServer.listen(this.port);
    this.generateProxyPac();
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
      "Content-Type": "application/x-ns-proxy-autoconfig",
    });
    response.end(this.proxyPacText);
  }

  generateProxyPac() {
    const urlToProxy = (proxyUrl: string) => {
      const url = new URL(proxyUrl);
      const hostport = url.href.slice(url.protocol.length + 2);
      const type = url.protocol.slice(0, -1).toUpperCase();
      return `"${type} ${hostport}"`;
    };

    this.proxyPacText = `

function FindProxyForURL(url, host) {

`;
    proxyMap.forEach(({ proxyUrl }, k) => {
      this.proxyPacText += `  if (url.match(/${
        k.source
      }/)) { return ${urlToProxy(proxyUrl)}; }\n`;
    });

    this.proxyPacText += `\n  return ${
      defaultProxyEntry ? urlToProxy(defaultProxyEntry.proxyUrl) : `"DIRECT"`
    };
}
`;
  }
}
