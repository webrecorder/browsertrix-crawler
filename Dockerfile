ARG BROWSER_VERSION=90

ARG BROWSER_IMAGE_BASE=oldwebtoday/chrome

FROM ${BROWSER_IMAGE_BASE}:${BROWSER_VERSION} as chrome

#FROM nikolaik/python-nodejs:python3.9-nodejs16
FROM ubuntu:bionic

#RUN apt-get update -y && apt-get install --no-install-recommends -qqy software-properties-common \
#&& add-apt-repository -y ppa:deadsnakes \
RUN apt-get update -y \
    && apt-get install --no-install-recommends -qqy build-essential fonts-stix locales-all redis-server xvfb gpg-agent curl git \
		python3 python3-distutils python3-dev gpg ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - \
    && echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list \
    && curl -sL https://deb.nodesource.com/setup_16.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh \
		&& apt-get update -y && apt-get install -qqy nodejs yarn \
    && curl https://bootstrap.pypa.io/get-pip.py | python3 \
    && pip3 install -U setuptools

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

WORKDIR /app

ADD requirements.txt /app/
RUN pip3 install -r requirements.txt

ADD package.json /app/

# to allow forcing rebuilds from this stage
ARG REBUILD

RUN yarn install

ADD uwsgi.ini /app/
ADD *.js /app/
ADD util/*.js /app/util/
COPY config.yaml browsertrixArgsConfig* /app/
ADD screencast/ /app/screencast/

RUN ln -s /app/main.js /usr/bin/crawl
RUN ln -s /app/create-login-profile.js /usr/bin/create-login-profile

WORKDIR /crawls

CMD ["crawl"]

