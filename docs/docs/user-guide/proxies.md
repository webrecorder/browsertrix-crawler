# Crawling with Proxies
Browser Crawler supports crawling through HTTP and SOCKS5 proxies, including through a SOCKS5 proxy over an SSH tunnel.

To specify a proxy, the `PROXY_SERVER` environment variable or `--proxyServer` cli flag can be passed in.
If both are provided, the `--proxyServer` CLI flag will take precedence.

(For backwards compatibility with 0.x, `PROXY_HOST` and `PROXY_PORT` environment variables can be used instead of `PROXY_SERVER`,
which takes precedence).

The proxy server can be specified as a `http://`, `socks5://`, or `ssh://` URL.

### HTTP Proxies

To crawl through an HTTP proxy running at `http://path-to-proxy-host.example.com:9000`, run the crawler with:

```sh
docker run -v $PWD/crawls/:/crawls/ -e PROXY_SERVER=http://path-to-proxy-host.example.com:9000 webrecorder/browsertrix-crawler crawl --url https://example.com/
```

or

```sh
docker run -v $PWD/crawls/:/crawls/ webrecorder/browsertrix-crawler crawl --url https://example.com/ --proxyServer http://path-to-proxy-host.example.com:9000 
```

The crawler does not support authentication for HTTP proxies, as that is not supported by the browser.

### SOCKS5 Proxies

To use a SOCKS5 proxy running at `path-to-proxy-host.example.com:9001`, run the crawler with:

```sh
docker run -v $PWD/crawls/:/crawls/ -e PROXY_SERVER=socks5://path-to-proxy-host.example.com:9001 webrecorder/browsertrix-crawler crawl --url https://example.com/
```

The crawler does support password authentication for SOCKS5 proxies, which can be provided in the proxy URL:

```sh
docker run-v $PWD/crawls/:/crawls/ -e PROXY_SERVER=socks5://user@pass:path-to-proxy-host.example.com:9001 webrecorder/browsertrix-crawler crawl --url https://example.com/
```

### SSH Proxies

The crawler also supports crawling through an SOCKS5 that is established over an SSH tunnel, via `ssh -D`.
With this option, the crawler can SSH into a remote machine and crawl through that machine's network.

To use this proxy, the private SSH key file must be provided via `--sshProxyPrivateKeyFile` cli argument.

The private key and public host key should be mounted as volumes into some path in the container.

For example, to connect via SSH to host `path-to-ssh-host.example.com` as user `user` with private key stored in `./my-proxy-private-key`, run:

```sh
docker run -v $PWD/crawls/:/crawls/ -v $PWD/my-proxy-private-key:/tmp/private-key webrecorder/browsertrix-crawler crawl --url https://httpbin.org/ip --proxyServer ssh://user@path-to-ssh-host.example.com --sshProxyPrivateKeyFile /tmp/private-key
```

To also provide the host public key (eg. `./known_hosts` file) for additional verification, run:

```sh
docker run -v $PWD/crawls/:/crawls/ -v $PWD/my-proxy-private-key:/tmp/private-key -v $PWD/known_hosts:/tmp/known_hosts webrecorder/browsertrix-crawler crawl --url https://httpbin.org/ip --proxyServer ssh://user@path-to-ssh-host.example.com --sshProxyPrivateKeyFile /tmp/private-key --sshProxyKnownHostsFile /tmp/known_hosts
```

The host key will only be checked if provided in a file via: `--sshProxyKnownHostsFile`.

A custom SSH port can be provided with `--proxyServer ssh://user@path-to-ssh-host.example.com:2222`, otherwise the
connection will be attempted via the standard 22 port.

The SSH connection establishes a local port (9722 by default) which will forward inbound/outbound traffic through the remote proxy.
The `autossh` utility is used to guard for ssh issues.

For SSH proxies, only key-based authentication is supposed.

## Browser Profiles

The above proxy settings also apply to [Browser Profile Creation](./browser-profiles), and browser profiles can also be created using proxies, eg:

```sh
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles -v $PWD/my-proxy-private-key:/tmp/private-key -v $PWD/known_hosts:/tmp/known_hosts webrecorder/browsertrix-crawler create-login-profile --url https://example.com/ --proxyServer ssh://user@path-to-ssh-host.example.com --sshProxyPrivateKeyFile /tmp/private-key --sshProxyKnownHostsFile /tmp/known_hosts
```





