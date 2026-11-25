#!/bin/sh
# Container entrypoint: make the storage directory writable (mounted disks and volumes are often root-owned),
# then run the app as the unprivileged "node" user.
set -e
STORAGE_DIR="${STORAGE_DIR:-/data/storage}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$STORAGE_DIR"
  chown -R node:node "$STORAGE_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
