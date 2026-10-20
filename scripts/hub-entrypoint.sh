#!/bin/sh
# The hub image's entrypoint (DOR-2935): give the data folder to the node user,
# then run the command as node, never as root.
#
# DorkOS Cloud mounts a new volume at the data folder owned by root, so the
# node user could not write to it on first boot. This runs as root only long
# enough to fix that. It changes ownership only when the folder is not already
# node's, so a hub that wakes with its own data does not walk the volume.
set -eu

data="${DORK_HOME:-/home/node/.dork}"

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data"
  if [ "$(stat -c %u "$data")" != "$(id -u node)" ]; then
    chown -R node:node "$data"
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
