matchHosts:
  old.webrecorder.net: ssh-proxy

proxies:
  ssh-proxy:
    url: ssh://proxy-not-found:1081
    ignoreOnFailedSSHTunnel: true

  # this is ignored as the proxy is not used in matchHosts
  unused-ssh-proxy: ssh://proxy-not-found:1082
