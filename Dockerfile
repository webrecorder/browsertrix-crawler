ARG BROWSER_IMAGE_BASE=webrecorder/browsertrix-browser-base
ARG BROWSER_VERSION=101

FROM ${BROWSER_IMAGE_BASE}:${BROWSER_VERSION}

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

