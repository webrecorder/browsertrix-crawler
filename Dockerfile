FROM oldwebtoday/chrome:84 as chrome

FROM nikolaik/python-nodejs:python3.8-nodejs14

RUN apt-get update -y \
    && apt-get install --no-install-recommends -qqy fonts-stix locales-all redis-server \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PROXY_HOST=localhost \
    PROXY_PORT=8080 \
    PROXY_CA_URL=http://wsgiprox/download/pem \
    PROXY_CA_FILE=/tmp/proxy-ca.pem \
    NO_SOCAT=1

RUN pip install uwsgi

RUN pip install git+https://github.com/webrecorder/pywb@patch-work

COPY --from=chrome /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=chrome /lib/x86_64-linux-gnu/libdbus* /lib/x86_64-linux-gnu/
COPY --from=chrome /opt/google/chrome/ /opt/google/chrome/

WORKDIR /app

ADD package.json /app/

RUN yarn install

ADD config.yaml /app/
ADD uwsgi.ini /app/
ADD crawler.js /app/
ADD autoplay.js /app/

ENTRYPOINT ["crawler.js"]

