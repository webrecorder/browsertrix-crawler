#!/bin/bash
set -euo pipefail

TARGET_ARCH=${1:-amd64}
YTDLP_VERSION=$2
DENO_VERSION=$3

if [ $TARGET_ARCH = "amd64" ]; then
    deno_arch=x86_64-unknown-linux-gnu
    ytdlp_exe=yt-dlp_linux
else
    deno_arch=aarch64-unknown-linux-gnu
    ytdlp_exe=yt-dlp_linux_aarch64
fi

apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*

# Deno is necessary for yt-dlp to work with most current YouTube videos.
cd /tmp
curl -L https://dl.deno.land/release/${DENO_VERSION}/deno-${deno_arch}.zip > /tmp/deno.zip
unzip deno.zip
mv deno /usr/bin/deno
chmod +x /usr/bin/deno

# This version of yt-dlp is self-contained with an embedded Python interpreter
# and C extensions prebuilt for native components.
curl -L https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytdlp_exe} > /tmp/yt-dlp
mv yt-dlp /usr/bin/yt-dlp
chmod +x /usr/bin/yt-dlp
