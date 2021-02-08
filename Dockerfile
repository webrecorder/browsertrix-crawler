ARG BROWSER_VERSION=88

FROM oldwebtoday/chrome:${BROWSER_VERSION} as chrome

FROM nikolaik/python-nodejs:python3.8-nodejs14

RUN apt-get update -y \
    && apt-get install --no-install-recommends -qqy fonts-stix locales-all redis-server xvfb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ARG BROWSER_VERSION

ENV PROXY_HOST=localhost \
    PROXY_PORT=8080 \
    PROXY_CA_URL=http://wsgiprox/download/pem \
    PROXY_CA_FILE=/tmp/proxy-ca.pem \
    DISPLAY=:99 \
    GEOMETRY=1360x1020x16 \
    BROWSER_VERSION=${BROWSER_VERSION}

COPY --from=chrome /tmp/*.deb /deb/
COPY --from=chrome /app/libpepflashplayer.so /app/libpepflashplayer.so
RUN dpkg -i /deb/*.deb; apt-get update; apt-get install -fqqy && \
    rm -rf /var/lib/opts/lists/*

RUN pip install pywb>=2.5.0 uwsgi wacz

WORKDIR /app

ADD package.json /app/

RUN yarn install

ADD config.yaml /app/
ADD uwsgi.ini /app/
ADD *.js /app/

RUN ln -s /app/main.js /usr/bin/crawl

WORKDIR /crawls

CMD ["crawl"]

