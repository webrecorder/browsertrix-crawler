#!/bin/bash
set -euo pipefail

TARGET_ARCH=${1:-amd64}
YTDLP_VERSION=$2

if [ $TARGET_ARCH = "amd64" ]; then
    ytdlp_exe=yt-dlp_linux
else
    ytdlp_exe=yt-dlp_linux_aarch64
fi

# This version of yt-dlp is self-contained with an embedded Python interpreter
# and C extensions prebuilt for native components.
cd /tmp
curl -L https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytdlp_exe} > /tmp/yt-dlp
mv yt-dlp /usr/bin/yt-dlp
chmod +x /usr/bin/yt-dlp
