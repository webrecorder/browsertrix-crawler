# Crawling with Proxies
Browser Crawler supports crawling through HTTP and SOCKS5 proxies, including through a SOCKS5 proxy over an SSH tunnel.

To specify a proxy, the `PROXY_SERVER` environment variable or `--proxyServer` CLI flag can be passed in.
If both are provided, the `--proxyServer` CLI flag will take precedence.

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

The crawler *does not* support authentication for HTTP proxies, as that is not supported by the browser.

(For backwards compatibility with crawler 0.x, `PROXY_HOST` and `PROXY_PORT` environment variables can be used to specify an HTTP proxy instead of `PROXY_SERVER`
which takes precedence if provided).


### SOCKS5 Proxies

To use a SOCKS5 proxy running at `path-to-proxy-host.example.com:9001`, run the crawler with:

```sh
docker run -v $PWD/crawls/:/crawls/ -e PROXY_SERVER=socks5://path-to-proxy-host.example.com:9001 webrecorder/browsertrix-crawler crawl --url https://example.com/
```

The crawler *does* support password authentication for SOCKS5 proxies, which can be provided as `user:password` in the proxy URL:

```sh
docker run-v $PWD/crawls/:/crawls/ -e PROXY_SERVER=socks5://user:password@path-to-proxy-host.example.com:9001 webrecorder/browsertrix-crawler crawl --url https://example.com/
```

### SSH Proxies

Starting with 1.3.0, the crawler also supports crawling through an SOCKS5 that is established over an SSH tunnel, via `ssh -D`.
With this option, the crawler can SSH into a remote machine that has SSH and port forwarding enabled and crawl through that machine's network.

To use this proxy, the private SSH key file must be provided via `--sshProxyPrivateKeyFile` CLI flag.

The private key and public host key should be mounted as volumes into a path in the container, as shown below.

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
connection will be attempted via the default SSH port (port 22).

The SSH connection establishes a tunnel on a local port in the container (9722) which will forward inbound/outbound traffic through the remote proxy.
The `autossh` utility is used to automatically restart the SSH connection, if needed.

Only key-based authentication is supposed for SSH proxies for now.

## Browser Profiles

The above proxy settings also apply to [Browser Profile Creation](browser-profiles.md), and browser profiles can also be created using proxies, for example:

```sh
docker run -p 6080:6080 -p 9223:9223 -v $PWD/crawls/profiles:/crawls/profiles -v $PWD/my-proxy-private-key:/tmp/private-key -v $PWD/known_hosts:/tmp/known_hosts webrecorder/browsertrix-crawler create-login-profile --url https://example.com/ --proxyServer ssh://user@path-to-ssh-host.example.com --sshProxyPrivateKeyFile /tmp/private-key --sshProxyKnownHostsFile /tmp/known_hosts
```

## Host-Specific Proxies

With the 1.7.0 release, the crawler also supports running with multiple proxies, defined in a separate proxy YAML config file. The file contains a match hosts section, matching hosts by regex to named proxies.

For example, the following YAML file can be passed to `--proxyConfigFile` option:

```yaml
matchHosts:
  # load all URLs from example.com through 'example-1-proxy'
  example.com/.*: example-1-proxy

  # load all URLS from https://my-social.example.com/.*/posts/ through
  # a different proxy
  https://my-social.example.com/.*/posts/: social-proxy

  # optional default proxy
  "": default-proxy

proxies:
  # SOCKS5 proxy just needs a URL
  example-1-proxy: socks5://username:password@my-socks-5-proxy.example.com

  # SSH proxy also should have at least a 'privateKeyFile'
  social-proxy:
    url: ssh://user@my-social-proxy.example.com
    privateKeyFile: /proxies/social-proxy-private-key
    # optional
    publicHostsFile: /proxies/social-proxy-public-hosts

  default-proxy:
    url: ssh://user@my-social-proxy.example.com
    privateKeyFile: /proxies/default-proxy-private-key
```

If the above config is stored in `./proxies/proxyConfig.yaml` along with the SSH private keys and known public hosts
files, the crawler can be started with:

```sh
docker run -v $PWD/crawls:/crawls -v $PWD/proxies:/proxies -it webrecorder/browsertrix-crawler --url https://example.com/ --proxyServerConfig /proxies/proxyConfig.yaml
```

Note that if SSH proxies are provided, an SSH tunnel must be opened for each one before the crawl starts.
The crawl will not start if any of the SSH proxy connections fail, even if a host-specific proxy is not actually used.
SOCKS5 and HTTP proxy connections are attempted only on first use.

The same `--proxyServerConfig` option can also available be used browser profile creation `create-login-profile` command in the same way.

### Proxy Precedence

If both `--proxyServerConfig` and `--proxyServer`/`PROXY_SERVER` env var are specified, the single `--proxyServer`
option takes precedence.


