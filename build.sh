#!/bin/bash

set -ex

DOCKER_TAG=browsertrix

if [ "$#" -gt "0" ]; then
    DOCKER_TAG=$1
fi

if [ -z "$DOCKER_TAG" ]; then
    echo "Docker tag not defined"
    exit 1
fi

docker build --tag "$DOCKER_TAG"  .

build_status=$?
if [ $build_status -eq 0 ]; then
    echo "docker image build successfully"
else
    echo "ERROR: Docker build failed"
    exit 1
fi