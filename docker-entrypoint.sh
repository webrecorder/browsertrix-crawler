#!/bin/sh

set -e

# Get UID/GID from volume dir
VOLUME_UID=$(stat -c '%u' /crawls)
VOLUME_GID=$(stat -c '%g' /crawls)

MY_UID=$(id -u)
MY_GID=$(id -g)

# Run as custom user
if [ "$MY_GID" != "$VOLUME_GID" ] || [ "$MY_UID" != "$VOLUME_UID" ]; then
    # create or modify user and group to match expected uid/gid
    groupadd --gid $VOLUME_GID archivist || groupmod -o --gid $VOLUME_GID archivist
    useradd -ms /bin/bash -u $VOLUME_UID -g $VOLUME_GID archivist || usermod -o -u $VOLUME_UID archivist

    cmd="cd $PWD; $@"

    # run process as new archivist user
    su archivist -c "$cmd"

# run as current user (root)
else
    exec $@
fi

