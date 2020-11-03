FROM oldwebtoday/chrome:84 as chrome

FROM nikolaik/python-nodejs:python3.8-nodejs14

RUN apt-get update -y \
    && apt-get install --no-install-recommends -qqy fonts-stix locales-all redis-server xvfb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PROXY_HOST=localhost \
    PROXY_PORT=8080 \
    PROXY_CA_URL=http://wsgiprox/download/pem \
    PROXY_CA_FILE=/tmp/proxy-ca.pem \
    DISPLAY=:99 \
    GEOMETRY=1360x1020x16

RUN pip install git+https://github.com/webrecorder/pywb@patch-work

RUN pip install uwsgi 'gevent>=20.9.0'

COPY --from=chrome /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=chrome /lib/x86_64-linux-gnu/libdbus* /lib/x86_64-linux-gnu/
COPY --from=chrome /opt/google/chrome/ /opt/google/chrome/

WORKDIR /app

ADD package.json /app/

RUN yarn install

ADD config.yaml /app/
ADD uwsgi.ini /app/
ADD *.js /app/

RUN ln -s /app/main.js /usr/bin/crawl
RUN ln -s /opt/google/chrome/google-chrome /usr/bin/google-chrome

WORKDIR /crawls

CMD ["crawl"]

