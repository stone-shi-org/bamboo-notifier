#!/usr/bin/env bash
#
# Build and tag the container image.
#
#   ./build.sh                build+tag registry.shifamily.com/homestack/bamboo-notifier locally
#   ./build.sh -p              build, tag, and push to that registry
#   ./build.sh -t v1.2 -p       add an extra tag, then push it too
#   ./build.sh -r other.registry.example.com/x -p   push somewhere else instead
#   BN_REGISTRY=other.registry.example.com/x ./build.sh -p   same, via environment
#
# Registry precedence: -r flag > BN_REGISTRY env var > registry.shifamily.com/homestack
# (this repo's home). Building always happens locally; nothing is pushed unless -p is given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="bamboo-notifier"
REGISTRY="${BN_REGISTRY:-registry.shifamily.com/homestack}"
PUSH=0
EXTRA_TAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--push)     PUSH=1; shift ;;
        -t|--tag)      EXTRA_TAG="$2"; shift 2 ;;
        -r|--registry) REGISTRY="$2"; shift 2 ;;
        -h|--help)     sed -n '2,13p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

log() { echo "==> $*"; }

# REPO is the full tag prefix, e.g. "registry.shifamily.com/homestack/bamboo-notifier".
REPO="${REGISTRY:+${REGISTRY}/}${IMAGE}"

# version.txt is baked into the image and surfaced on the dashboard (and /api/status), so
# a running container can always be traced back to a commit. git status --porcelain (not
# a two-way diff) so an untracked file counts as dirty too.
FULL_HASH="$(git rev-parse HEAD 2>/dev/null || true)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -z "$FULL_HASH" ]; then
    HASH="dev"
else
    HASH="${FULL_HASH:0:7}"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        HASH="${HASH}-dev"
    fi
fi

{
    echo "hash=${HASH}"
    echo "timestamp=${TIMESTAMP}"
} > version.txt

log "Version: ${HASH} (${TIMESTAMP})"

log "Building ${REPO}:latest"
docker build \
    -t "${REPO}:latest" \
    -t "${REPO}:${HASH}" \
    ${EXTRA_TAG:+-t "${REPO}:${EXTRA_TAG}"} \
    .

log "Built:"
docker images "${REPO}" --format '    {{.Repository}}:{{.Tag}}  {{.Size}}'

if [ "$PUSH" -eq 1 ]; then
    log "Pushing to ${REGISTRY}"
    docker push "${REPO}:latest"
    docker push "${REPO}:${HASH}"
    [ -n "$EXTRA_TAG" ] && docker push "${REPO}:${EXTRA_TAG}"
    log "Pushed"
else
    log "Not pushed. Re-run with -p to push to ${REGISTRY}."
fi
