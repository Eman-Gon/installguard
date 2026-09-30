#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .daytona
if ! docker info >/dev/null 2>&1; then
  nohup dockerd > .daytona/dockerd.log 2>&1 < /dev/null &
  attempt=0
  until docker info >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then echo 'Docker startup failed; inspect .daytona/dockerd.log' >&2; exit 1; fi
    sleep 1
  done
fi
docker image inspect installguard-worker:node22.11.0 >/dev/null
