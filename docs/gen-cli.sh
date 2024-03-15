#!/bin/bash
CURR=$(dirname "${BASH_SOURCE[0]}")

out=$CURR/docs/user-guide/cli-options.md
echo "# All Command-Line Options" > $out
echo "" >> $out
echo "The Browsertrix Crawler Docker image currently accepts the following parameters:" >> $out
echo "" >> $out
echo '```' >> $out
docker run webrecorder/browsertrix-crawler crawl --help >> $out
#node $CURR/../dist/main.js --help >> $out
echo '```' >> $out


