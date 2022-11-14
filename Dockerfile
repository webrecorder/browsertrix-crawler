ARG BROWSER_IMAGE_BASE=webrecorder/browsertrix-browser-base
ARG BROWSER_VERSION=105

FROM ${BROWSER_IMAGE_BASE}:${BROWSER_VERSION}

RUN apt-get update && apt-get install -y jq

ENV RUSTUP_HOME=/rust
ENV CARGO_HOME=/cargo 
ENV PATH=/cargo/bin:/rust/bin:$PATH

RUN echo "(curl https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain nightly --no-modify-path)" > /install-rust.sh && chmod 755 /install-rust.sh
RUN /install-rust.sh

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
    OPENSSL_CONF=/app/openssl.conf

WORKDIR /app

ADD requirements.txt /app/
RUN pip install 'uwsgi==2.0.20'
RUN pip install -U setuptools; pip install -r requirements.txt

ADD package.json /app/

# to allow forcing rebuilds from this stage
ARG REBUILD

# Download and format ad host blocklist as JSON
RUN mkdir -p /tmp/ads && cd /tmp/ads && \
    curl -vs -o ad-hosts.txt https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts && \
    cat ad-hosts.txt | grep '^0.0.0.0 '| awk '{ print $2; }' | grep -v '0.0.0.0' | jq --raw-input --slurp 'split("\n")' > /app/ad-hosts.json && \
    rm /tmp/ads/ad-hosts.txt

# Add cookie popup blocklist
RUN curl -vs -o /app/easylist-cookies.txt https://secure.fanboy.co.nz/fanboy-cookiemonster.txt

RUN yarn install

ADD *.js /app/
ADD util/*.js /app/util/

ADD config/ /app/

ADD html/ /app/html/

RUN ln -s /app/main.js /usr/bin/crawl; ln -s /app/create-login-profile.js /usr/bin/create-login-profile

WORKDIR /crawls

ADD docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["crawl"]

