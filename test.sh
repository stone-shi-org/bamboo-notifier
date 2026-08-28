#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Run inside the same node:22-alpine image the Dockerfile ships on, so results don't
# depend on whatever Node happens to be installed on the machine invoking this script -
# node:sqlite (see db.js) needs Node >=22.5 and isn't available on older Node, including
# on CI agents whose system Node lags behind what this repo requires (see AGENTS.md
# "Runtime"). Falls back to running directly on the host's own `npm` if Docker isn't
# available (e.g. a dev machine without Docker but with a recent enough Node already).
if command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$SCRIPT_DIR":/app -w /app node:22-alpine sh -c "npm ci && npm test"
else
  echo "docker not found; running tests with the host's own node/npm instead (requires Node >=22.5)." >&2
  npm ci
  npm test
fi
