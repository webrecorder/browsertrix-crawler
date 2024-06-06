import { Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

import { socksDispatcher } from "fetch-socks";
import type { SocksProxyType } from "socks/typings/common/constants.js";

export function getProxy() {
  if (process.env.PROXY_SERVER) {
    return process.env.PROXY_SERVER;
  }

  // for backwards compatibility with 0.x proxy settings
  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    return `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
  }

  return "";
}

export function initDispatcher() {
  const dispatcher = createDispatcher();
  if (dispatcher) {
    setGlobalDispatcher(dispatcher);
  }
}

export function createDispatcher(): Dispatcher | undefined {
  const proxyUrl = getProxy();
  if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
    return new ProxyAgent({ uri: proxyUrl });
  } else if (
    proxyUrl.startsWith("socks://") ||
    proxyUrl.startsWith("socks5://") ||
    proxyUrl.startsWith("socks4://")
  ) {
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
