#!/usr/bin/env bash
# Sends a signed, synthetic GitHub "push" webhook delivery to a running bamboo-notifier
# instance, so you can test signature verification + repo->plan mapping + Bamboo triggering
# end to end without needing GitHub itself.
#
# Usage:
#   WEBHOOK_SECRET=... ./scripts/send-test-webhook.sh [url] [repo_full_name] [branch]
#
# Example:
#   WEBHOOK_SECRET=devsecret ./scripts/send-test-webhook.sh \
#     http://localhost:3000/webhook/github myorg/example-service main

set -euo pipefail

URL="${1:-http://localhost:3000/webhook/github}"
REPO="${2:-myorg/example-service}"
BRANCH="${3:-main}"

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "ERROR: set WEBHOOK_SECRET in the environment (must match the running server's secret)." >&2
  exit 1
fi

DELIVERY_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')"

PAYLOAD=$(cat <<EOF
{
  "ref": "refs/heads/${BRANCH}",
  "deleted": false,
  "repository": { "full_name": "${REPO}" },
  "pusher": { "name": "test-script" }
}
EOF
)

SIGNATURE="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')"

echo "POST $URL"
echo "repo=$REPO branch=$BRANCH delivery=$DELIVERY_ID"
echo

curl -sS -i "$URL" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIGNATURE}" \
  --data "$PAYLOAD"
echo
