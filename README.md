# bamboo-notifier

A tiny service that receives GitHub **organization-wide webhook** deliveries and, on
`push` events, triggers a build of the matching plan on the local Bamboo instance
(`https://bamboo.local.shifamily.com`).

Flow: `git push` → GitHub org webhook → `POST /webhook/github` → look up repo in
`config/repo-plan-map.json` → `POST {bamboo}/rest/api/latest/queue/{PLAN-KEY}.json`.

## How it works

- Verifies every request's `X-Hub-Signature-256` HMAC against `WEBHOOK_SECRET` before
  trusting anything in the body. Requests that don't verify get `401`.
- Responds `202` immediately after verifying + parsing, then calls Bamboo
  asynchronously — a slow/down Bamboo never causes a GitHub delivery timeout.
- Only acts on the `push` event. `ping` gets a friendly `200 pong`. Any other event
  type (an org webhook can be subscribed to many) is acknowledged with `200` and
  ignored, so GitHub never sees a failed delivery for events we don't care about.
- Branch/tag **deletion** pushes (`deleted: true`) are ignored — nothing to build.
- Repos not present in `config/repo-plan-map.json` are logged and ignored, so you can
  point the org webhook at every repo and only opt specific ones into building.
- The map file is re-read live (`fs.watch`) — edit it without restarting the container
  (falls back to requiring a restart if the mount doesn't support `fs.watch`, e.g. some
  bind-mount setups).
- Keeps an in-memory status/activity log (see **Dashboard** below) for debugging —
  it's not persisted and resets on restart; it's a debugging aid, not an audit trail.

## Repo → plan mapping (`config/repo-plan-map.json`)

**This file is gitignored, on purpose.** It lists which internal Bamboo projects/plans
exist and which repos they build — that's internal infrastructure detail, not something
to publish in a public GitHub repo. `config/repo-plan-map.example.json` is the tracked
format reference; copy it to `config/repo-plan-map.json` and fill in real values (the
`.dockerignore` also excludes the real file, so it's never baked into the image either —
it's only ever delivered at runtime via the `docker-compose.yml` bind mount).

```json
{
  "myorg/example-service": [
    { "planKey": "EX-EX", "branches": ["main"] }
  ],
  "myorg/another-repo": [
    "AN-BUILD"
  ]
}
```

- Key: the GitHub repo's `full_name` (`owner/repo`), exactly as it appears in the
  webhook payload.
- Value: a list of Bamboo plan keys to trigger for that repo. A plain string builds on
  every push to any branch; an object with `branches` restricts it to those branches
  (e.g. only `main`).
- Remember a Bamboo *plan key* (e.g. `EX-EX`) is not the same as a *project key*
  (`EX`) — find it under the plan's **Actions > Configure plan** page, or via
  `GET {base}/rest/api/latest/project/{PROJECT-KEY}.json?expand=plans`.

## Configuration (environment variables)

| Var | Required | Default | Notes |
|---|---|---|---|
| `WEBHOOK_SECRET` | yes | — | Must match the secret set on the GitHub webhook |
| `BAMBOO_TOKEN` | yes | — | Bamboo personal access token |
| `BAMBOO_BASE_URL` | no | `https://bamboo.local.shifamily.com` | |
| `PORT` | no | `3000` | |
| `REPO_PLAN_MAP` | no | `config/repo-plan-map.json` | Path override |
| `BAMBOO_TIMEOUT_MS` | no | `10000` | Abort a stuck Bamboo call after this long |
| `MAX_LOG_ENTRIES` | no | `500` | How many recent deliveries the dashboard keeps in memory |
| `STATUS_USER` / `STATUS_PASSWORD` | no | unset | HTTP Basic Auth for the dashboard/`/api/status`. Both or neither — see **Dashboard** |

Copy `.env.example` to `.env` and fill in real values (`.env` is gitignored).

## Run it

### Docker (recommended)

```bash
cp .env.example .env    # fill in WEBHOOK_SECRET and BAMBOO_TOKEN
# edit config/repo-plan-map.json for your repos/plans
docker compose up -d --build
docker compose logs -f
```

### Locally with Node

```bash
npm install
export WEBHOOK_SECRET=devsecret
source ~/.secrets/bamboo.env   # provides BAMBOO_TOKEN
node server.js
```

## Configure the GitHub organization webhook

Org settings → **Settings → Webhooks → Add webhook** (needs org admin):

- Payload URL: `https://<your-public-ingress>/webhook/github`
- Content type: **`application/json`** (required — the service doesn't parse form-encoded bodies)
- Secret: same value as `WEBHOOK_SECRET`
- Events: **Just the push event** is enough; if you subscribe to "Send me everything"
  that's fine too, non-push events are just acknowledged and ignored.

After saving, GitHub sends a `ping` — check **Recent Deliveries** on the webhook page
for a `200`/`pong` response, and `docker compose logs` on this side.

## Testing

1. Bamboo reachability/token sanity check (uses `BAMBOO_TOKEN` from `~/.secrets/bamboo.env`):
   ```bash
   source ~/.secrets/bamboo.env
   curl -s -H "Authorization: Bearer $BAMBOO_TOKEN" \
     "https://bamboo.local.shifamily.com/rest/api/latest/project.json?max-results=1"
   ```

2. End-to-end against a running instance, without needing GitHub at all:
   ```bash
   WEBHOOK_SECRET=devsecret ./scripts/send-test-webhook.sh \
     http://localhost:3000/webhook/github myorg/example-service main
   ```
   This sends a properly HMAC-signed synthetic `push` payload. Watch the server logs —
   it should log `[bamboo] triggered plan=... buildResultKey=...` if the repo is mapped,
   or `no plan mapping for repo=...` if it isn't (edit `config/repo-plan-map.json` and
   try again — no restart needed).

3. Real webhook: from the GitHub webhook's "Recent Deliveries" tab, use **Redeliver**
   on any past push delivery to re-send it to your endpoint.

## Health check

`GET /healthz` → `200 ok`. Used by the Docker Compose healthcheck.

## Dashboard

`GET /` serves a status page (auto-refreshes every 5s via `GET /api/status`, which is
also useful directly with `curl` for scripting/debugging):

- **Statistics** — deliveries received, builds triggered, trigger failures, signature
  rejections, event-type breakdown.
- **Configuration** — Bamboo base URL, map file path, listen port.
- **Repo → plan mapping** — the live contents of `config/repo-plan-map.json`, plus a
  push count per repo.
- **Recent activity** — every delivery since the process started (newest first, capped
  at `MAX_LOG_ENTRIES`), with timestamp, repo, ref, event, outcome
  (`dispatched`/`done`/`ignored_no_mapping`/`rejected_signature`/...), per-plan trigger
  status (`triggered` with the Bamboo `buildResultKey`, `failed`/`error` with the
  reason, or `skipped_branch`), and the GitHub delivery ID (handy for cross-referencing
  with the webhook's own "Recent Deliveries" tab when debugging).

This resets on restart and is not written to disk — it's a debugging aid, not an audit
trail. If you need history across restarts, use `docker compose logs`, which has the
same information as plain text lines.

**Auth:** the dashboard and `/api/status` are open by default (`/webhook/github` and
`/healthz` are never gated, since GitHub and container healthchecks can't do a login
prompt). If this port is reachable from anywhere untrusted, set `STATUS_USER` +
`STATUS_PASSWORD` to require HTTP Basic Auth on everything else.

## Building and publishing the image

```bash
./build.sh          # build + tag registry.shifamily.com/homestack/bamboo-notifier locally
./build.sh -p        # build, tag, and push
./build.sh -t v1.2 -p   # also add and push an extra tag
```

Every build stamps `version.txt` with the short git commit hash (suffixed `-dev` if the
tree is dirty) and a UTC timestamp; the running container surfaces both at the top of
the dashboard and in `/api/status`, so a deployed instance can always be traced back to
a commit. `-r <registry>` or `BN_REGISTRY=<registry>` overrides the default registry.

## Exposing it to GitHub

This service only listens on `PORT` inside its container/host — it assumes you already
have (or will set up) a reverse proxy / public DNS name / load balancer with TLS in
front of it that forwards to that port. GitHub.com's webhook delivery requires an
HTTPS URL reachable from the public internet (GitHub does not support delivering to
private/internal-only addresses).

Only `/webhook/github` needs to be public. If you don't want the dashboard exposed the
same way, either restrict your ingress to that one path, or set `STATUS_USER`/
`STATUS_PASSWORD` and accept it being reachable behind a login prompt.
