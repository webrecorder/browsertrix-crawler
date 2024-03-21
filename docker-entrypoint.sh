#!/bin/sh

# Get UID/GID from volume dir

VOLUME_UID=$(stat -c '%u' /crawls)
VOLUME_GID=$(stat -c '%g' /crawls)

# Get the UID/GID we are running as

MY_UID=$(id -u)
MY_GID=$(id -g)

# If we aren't running as the owner of the /crawls/ dir then add a new user
# btrix with the same UID/GID of the /crawls dir and run as that user instead.

if [ "$MY_GID" != "$VOLUME_GID" ] || [ "$MY_UID" != "$VOLUME_UID" ]; then
    groupadd btrix
    groupmod -o --gid $VOLUME_GID btrix

    useradd -ms /bin/bash -g $VOLUME_GID btrix
    usermod -o -u $VOLUME_UID btrix > /dev/null

    export DETACHED_PROC=1
    exec gosu btrix:btrix "$@"
else
    exec "$@"
fi

