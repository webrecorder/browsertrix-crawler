ARG BROWSER_VERSION=1.64.109
ARG BROWSER_IMAGE_BASE=webrecorder/browsertrix-browser-base:brave-${BROWSER_VERSION}

FROM ${BROWSER_IMAGE_BASE}

# needed to add args to main build stage
ARG BROWSER_VERSION

ENV PROXY_HOST=localhost \
    PROXY_PORT=8080 \
    PROXY_CA_URL=http://wsgiprox/download/pem \
    PROXY_CA_FILE=/tmp/proxy-ca.pem \
    DISPLAY=:99 \
    GEOMETRY=1360x1020x16 \
    BROWSER_VERSION=${BROWSER_VERSION} \
    BROWSER_BIN=google-chrome \
    OPENSSL_CONF=/app/openssl.conf \
    VNC_PASS=vncpassw0rd! \
    DETACHED_CHILD_PROC=1

WORKDIR /app

ADD requirements.txt /app/
RUN pip install -U setuptools; pip install -r requirements.txt

ADD package.json /app/

# to allow forcing rebuilds from this stage
ARG REBUILD

# Prefetch tldextract so pywb is able to boot in environments with limited internet access
RUN tldextract --update 

# Download and format ad host blocklist as JSON
RUN mkdir -p /tmp/ads && cd /tmp/ads && \
    curl -vs -o ad-hosts.txt https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts && \
    cat ad-hosts.txt | grep '^0.0.0.0 '| awk '{ print $2; }' | grep -v '0.0.0.0' | jq --raw-input --slurp 'split("\n")' > /app/ad-hosts.json && \
    rm /tmp/ads/ad-hosts.txt

RUN yarn install --network-timeout 1000000

ADD tsconfig.json /app/
ADD src /app/src

RUN yarn run tsc

ADD config/ /app/

ADD html/ /app/html/

ARG RWP_VERSION=1.8.15
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/ui.js /app/html/rwp/
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/sw.js /app/html/rwp/

RUN chmod a+x /app/dist/main.js /app/dist/create-login-profile.js && chmod a+r /app/html/rwp/*

RUN ln -s /app/dist/main.js /usr/bin/crawl; \
    ln -s /app/dist/main.js /usr/bin/qa; \
    ln -s /app/dist/create-login-profile.js /usr/bin/create-login-profile

WORKDIR /crawls

# enable to test custom behaviors build (from browsertrix-behaviors)
# COPY behaviors.js /app/node_modules/browsertrix-behaviors/dist/behaviors.js

ADD docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["crawl"]

