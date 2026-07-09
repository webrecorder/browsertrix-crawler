ARG BROWSER_VERSION=1.91.175
ARG BROWSER_IMAGE_BASE=webrecorder/browsertrix-browser-base:brave-${BROWSER_VERSION}

FROM ${BROWSER_IMAGE_BASE}

LABEL org.opencontainers.image.vendor="Webrecorder <https://webrecorder.net/>"
LABEL org.opencontainers.image.documentation="https://crawler.docs.browsertrix.com/"

# set to 1 to minimize size for prod, but longer build time, otherwise faster build and rebuild but larger image
ARG MINIMIZE_IMAGE_SIZE=0

# needed to add args to main build stage
ARG BROWSER_VERSION

ENV GEOMETRY=1360x1020x16 \
    BROWSER_VERSION=${BROWSER_VERSION} \
    BROWSER_BIN=google-chrome \
    OPENSSL_CONF=/app/openssl.conf \
    VNC_PASS=vncpassw0rd! \
    DETACHED_CHILD_PROC=1

EXPOSE 9222 9223 6080

WORKDIR /app

ADD .yarnrc.yml package.json yarn.lock /app/

# to allow forcing rebuilds from this stage
ARG REBUILD

# Download and format ad host blocklist as JSON
RUN mkdir -p /tmp/ads && cd /tmp/ads && \
    curl -vs -o ad-hosts.txt https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts && \
    cat ad-hosts.txt | grep '^0.0.0.0 '| awk '{ print $2; }' | grep -v '0.0.0.0' | jq --raw-input --slurp 'split("\n")' > /app/ad-hosts.json && \
    rm /tmp/ads/ad-hosts.txt

RUN corepack enable yarn

# when not minimizing image size, do install here so that source changes do not trigger a rebuild (faster build)
RUN if [ "$MINIMIZE_IMAGE_SIZE" != "1" ] ; then \
      yarn install --network-timeout 1000000 --immutable; \
    fi

ADD tsconfig.json /app/
ADD src /app/src

# when not minimizing image size, do only compile here for faster build, otherwise do full install and clean up in one layer and reduce image size
RUN if [ "$MINIMIZE_IMAGE_SIZE" != "1" ] ; then \
      yarn run tsc; \
    else \
      yarn install --network-timeout 1000000 --immutable && \
      yarn run tsc && \
      yarn workspaces focus --production && \
      yarn cache clean && \
      rm -rf /root/.npm; \
    fi

ADD config/ /app/

ADD html/ /app/html/

ARG RWP_VERSION=2.4.6
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/ui.js /app/html/rwp/
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/sw.js /app/html/rwp/
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/adblock/adblock.gz /app/html/rwp/adblock.gz

RUN chmod a+x /app/dist/main.js /app/dist/create-login-profile.js /app/dist/indexer.js && chmod a+r /app/html/rwp/*

RUN ln -s /app/dist/main.js /usr/bin/crawl; \
    ln -s /app/dist/main.js /usr/bin/qa; \
    ln -s /app/dist/create-login-profile.js /usr/bin/create-login-profile; \
    ln -s /app/dist/indexer.js /usr/bin/indexer;

RUN mkdir -p /app/behaviors

WORKDIR /crawls

# enable to test custom behaviors build (from browsertrix-behaviors)
# COPY behaviors.js /app/node_modules/browsertrix-behaviors/dist/behaviors.js

# add brave/chromium group policies
RUN mkdir -p /etc/brave/policies/managed/
ADD config/policies /etc/brave/policies/managed/

ADD docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["crawl"]
