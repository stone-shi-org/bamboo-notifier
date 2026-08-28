#!/bin/sh
# /app/data is normally a bind-mounted volume (docker-compose.yml: ./data:/app/data) so
# the SQLite database survives restarts/rebuilds - see README "History & stats database".
# If the host-side ./data didn't exist yet, Docker auto-creates it owned by root:root,
# which the non-root "node" user this image otherwise runs as can't write into (that's
# exactly what caused "Error: unable to open database file" / SQLITE_CANTOPEN).
#
# We start the container as root so this script can fix that up, then drop to the
# unprivileged "node" user (via su-exec) before ever executing app code.
set -e

if [ "$(id -u)" = '0' ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi

# Already non-root (e.g. someone overrode USER) - just run it.
exec "$@"
