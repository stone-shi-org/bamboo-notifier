# AGENTS.md - Developer & Agent Guidelines for bamboo-notifier

This repository contains **bamboo-notifier**, a Node.js service that acts as a GitHub Organization Webhook receiver, mapping `push` events to Atlassian Bamboo plan build triggers.

---

## 1. Environment & Architecture

- **Runtime:** Node.js (>= v22.5, for the built-in `node:sqlite` module)
- **Module System:** ES Modules (`"type": "module"` in `package.json`, use `import`/`export` and `node:` protocol imports)
- **Framework:** Express (`express` v4)
- **Testing:** Node's built-in test runner (`node --test`)
- **Key Files:**
  - `server.js`: Main Express HTTP server, HMAC signature verification, status API, dashboard, and async Bamboo REST API triggering logic.
  - `db.js`: SQLite (`node:sqlite`) persistence for delivery/build-trigger history and stats. Default DB path `data/bamboo-notifier.db` (override with `DB_FILE`); bind-mounted to `/app/data` in `docker-compose.yml` so it survives restarts.
  - `config/repo-plan-map.json`: Runtime mapping from GitHub repo full names (`org/repo`) to Bamboo project/plan keys. (Gitignored; template provided at `config/repo-plan-map.example.json`).
  - `test/`: Node test runner test suites.
  - `build.sh` & `Dockerfile`: Container image build script.
  - `test.sh`: Automated test runner script.

---

## 2. Common Workflows & Commands

### Installing Dependencies
```bash
npm install
```

### Running Locally
```bash
WEBHOOK_SECRET="dev-secret" BAMBOO_TOKEN="dev-token" npm start
```

### Running Tests
Always run verification tests after modifying `server.js` or config handling:
```bash
npm test
# or
./test.sh
```
*Note: Test results are output in JUnit XML format to `test-reports/junit.xml`.*

---

## 3. Coding Guidelines & Constraints

1. **Native Node.js Features:**
   - Prefer Node's native standard library modules over third-party dependencies (`node:crypto`, `node:fs`, `node:path`, `node:sqlite`, global `fetch`).
   - `node:sqlite` requires Node >= 22.5 and is still flagged experimental upstream; it's run with `--disable-warning=ExperimentalWarning` (see `package.json` scripts and `Dockerfile` CMD) to keep logs clean. If Node's SQLite API changes in a breaking way on a future upgrade, `db.js` is the only file that touches it.
2. **Asynchronous Webhook Response Pattern:**
   - Webhook requests (`/webhook/github`) MUST respond immediately with HTTP 200 after validating HMAC signature and enqueueing triggers. Bamboo REST API calls run asynchronously in the background so slow upstream responses do not cause GitHub webhook timeouts.
3. **Security & Secrets:**
   - Never hardcode or commit secrets (`WEBHOOK_SECRET`, `BAMBOO_TOKEN`, `STATUS_PASSWORD`).
   - HMAC signature verification (`X-Hub-Signature-256`) uses `crypto.timingSafeEqual` to prevent timing attacks. Keep raw body capture intact.
4. **Configuration Hot-Reloading:**
   - `repo-plan-map.json` is watched via `fs.watch` for dynamic updates without container restarts. Maintain graceful error fallbacks when parsing or watching config files.

---

## 4. Verification Requirements

Before submitting code edits or claiming completion:
1. Run `./test.sh` or `npm test` and ensure all test suites pass with exit code `0`.
2. Inspect log output to confirm no uncaught promises or syntax errors occur.
