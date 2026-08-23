import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BAMBOO_BASE_URL = (process.env.BAMBOO_BASE_URL || 'https://bamboo.local.shifamily.com').replace(/\/+$/, '');
const BAMBOO_TOKEN = process.env.BAMBOO_TOKEN;
const DEFAULT_MAP_FILE = path.join(__dirname, 'config', 'repo-plan-map.json');
const EXAMPLE_MAP_FILE = path.join(__dirname, 'config', 'repo-plan-map.example.json');
let MAP_FILE = process.env.REPO_PLAN_MAP || DEFAULT_MAP_FILE;
const BAMBOO_TIMEOUT_MS = Number(process.env.BAMBOO_TIMEOUT_MS || 10000);
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 500);
// Optional HTTP Basic Auth in front of the dashboard/API (not the webhook or healthz -
// GitHub and container healthchecks can't do a login prompt). See README "Exposing it"
// section: if the dashboard shares a public ingress with the webhook, set these.
const STATUS_USER = process.env.STATUS_USER;
const STATUS_PASSWORD = process.env.STATUS_PASSWORD;

if (!WEBHOOK_SECRET) {
  console.error('FATAL: WEBHOOK_SECRET env var is required (must match the secret configured on the GitHub org webhook).');
  process.exit(1);
}
if (!BAMBOO_TOKEN) {
  console.error('FATAL: BAMBOO_TOKEN env var is required (Bamboo personal access token).');
  process.exit(1);
}
if ((STATUS_USER && !STATUS_PASSWORD) || (!STATUS_USER && STATUS_PASSWORD)) {
  console.error('FATAL: STATUS_USER and STATUS_PASSWORD must both be set, or both left unset.');
  process.exit(1);
}
if (!STATUS_USER) {
  console.warn('STATUS_USER/STATUS_PASSWORD not set - the dashboard and /api/status are UNAUTHENTICATED. Fine on a private network; set both if this port is reachable from anywhere untrusted.');
}

function loadVersionInfo() {
  const file = path.join(__dirname, 'version.txt');
  if (!fs.existsSync(file)) return { hash: 'dev', timestamp: null };
  const raw = fs.readFileSync(file, 'utf8');
  const hashMatch = raw.match(/^hash=(.+)$/m);
  const tsMatch = raw.match(/^timestamp=(.+)$/m);
  if (hashMatch) return { hash: hashMatch[1].trim(), timestamp: tsMatch ? tsMatch[1].trim() : null };
  return { hash: raw.trim() || 'dev', timestamp: null };
}
const VERSION = loadVersionInfo();

// The real map is gitignored/dockerignored on purpose (it reveals internal Bamboo
// project/plan keys) and is normally supplied at runtime via a bind mount. If nobody
// explicitly pointed REPO_PLAN_MAP elsewhere and the default file just isn't there
// (e.g. running the image standalone without the compose mount), fall back to the
// bundled example rather than refusing to start.
if (!process.env.REPO_PLAN_MAP && !fs.existsSync(MAP_FILE) && fs.existsSync(EXAMPLE_MAP_FILE)) {
  console.warn(`No repo-plan map at ${MAP_FILE}; falling back to the bundled example (${EXAMPLE_MAP_FILE}). Mount a real config/repo-plan-map.json for actual use - see README.`);
  MAP_FILE = EXAMPLE_MAP_FILE;
}

function loadMap() {
  const raw = fs.readFileSync(MAP_FILE, 'utf8');
  return JSON.parse(raw);
}

let repoPlanMap;
try {
  repoPlanMap = loadMap();
  console.log(`Loaded repo-plan map from ${MAP_FILE} (${Object.keys(repoPlanMap).length} repos configured).`);
} catch (err) {
  console.error(`FATAL: could not read/parse repo-plan map at ${MAP_FILE}: ${err.message}`);
  process.exit(1);
}

// Hot-reload the map file on change so plan mappings can be edited without a restart.
try {
  fs.watch(MAP_FILE, { persistent: false }, () => {
    try {
      repoPlanMap = loadMap();
      console.log(`Reloaded repo-plan map (${Object.keys(repoPlanMap).length} repos configured).`);
    } catch (err) {
      console.error(`Failed to reload repo-plan map, keeping previous version in memory: ${err.message}`);
    }
  });
} catch {
  // fs.watch is unreliable on some bind-mounted volumes; not fatal, just means edits need a restart.
  console.warn('fs.watch on the map file failed to start; edits to it will require a container restart.');
}

// ---- in-memory stats + recent-activity log, for the dashboard / debugging ----
// Deliberately not persisted anywhere: this is a debugging aid, not an audit trail.
// It resets on restart/redeploy, and only keeps the last MAX_LOG_ENTRIES deliveries.
const stats = {
  startedAt: new Date().toISOString(),
  received: 0,
  byEvent: {},
  pushByRepo: {},
  rejectedSignature: 0,
  triggered: 0,
  triggerFailed: 0,
};
const activityLog = [];

function recordEvent(entry) {
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
  return entry;
}

const app = express();
app.disable('x-powered-by');

// Everything except the webhook and the healthcheck can optionally require Basic Auth.
// Checked before body parsing so an unauthenticated caller never gets a JSON parse either.
app.use((req, res, next) => {
  if (req.path === '/webhook/github' || req.path === '/healthz') return next();
  if (!STATUS_USER) return next();

  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { /* fall through to 401 */ }
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    const userBuf = Buffer.from(user);
    const passBuf = Buffer.from(pass);
    const expUserBuf = Buffer.from(STATUS_USER);
    const expPassBuf = Buffer.from(STATUS_PASSWORD);
    const userOk = userBuf.length === expUserBuf.length && crypto.timingSafeEqual(userBuf, expUserBuf);
    const passOk = passBuf.length === expPassBuf.length && crypto.timingSafeEqual(passBuf, expPassBuf);
    if (userOk && passOk) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="bamboo-notifier"');
  return res.status(401).send('authentication required');
});

// Capture the raw body for HMAC verification while still parsing JSON for convenience.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '2mb',
}));

function verifySignature(req) {
  const sig = req.get('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function branchFromRef(ref) {
  // refs/heads/main -> main. Leaves refs/tags/... etc. as-is (rare to filter on those).
  return ref && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// Mutates planEntry in place (status/detail) so the activityLog entry it belongs to
// reflects the outcome as soon as it's known, even though the HTTP response already went out.
async function triggerBambooPlan(planKey, meta, planEntry) {
  const url = `${BAMBOO_BASE_URL}/rest/api/latest/queue/${encodeURIComponent(planKey)}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BAMBOO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BAMBOO_TOKEN}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      stats.triggerFailed++;
      planEntry.status = 'failed';
      planEntry.detail = `HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
      console.error(`[bamboo] trigger FAILED plan=${planKey} repo=${meta.repo} ref=${meta.ref} status=${res.status} body=${bodyText.slice(0, 500)}`);
      return;
    }
    let resultKey;
    try { resultKey = JSON.parse(bodyText).buildResultKey; } catch { /* ignore */ }
    stats.triggered++;
    planEntry.status = 'triggered';
    planEntry.detail = resultKey ?? 'triggered (no buildResultKey in response)';
    console.log(`[bamboo] triggered plan=${planKey} repo=${meta.repo} ref=${meta.ref} buildResultKey=${resultKey ?? 'unknown'}`);
  } catch (err) {
    stats.triggerFailed++;
    planEntry.status = 'error';
    planEntry.detail = err.message;
    console.error(`[bamboo] trigger ERROR plan=${planKey} repo=${meta.repo} ref=${meta.ref}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

app.post('/webhook/github', (req, res) => {
  const delivery = req.get('x-github-delivery') || null;
  const event = req.get('x-github-event') || null;

  if (!verifySignature(req)) {
    stats.rejectedSignature++;
    recordEvent({ ts: new Date().toISOString(), delivery, event, repo: null, ref: null, outcome: 'rejected_signature', plans: [] });
    console.warn(`[webhook] rejected: invalid or missing X-Hub-Signature-256 (delivery=${delivery})`);
    return res.status(401).send('invalid signature');
  }

  stats.received++;
  stats.byEvent[event] = (stats.byEvent[event] || 0) + 1;

  if (event === 'ping') {
    recordEvent({ ts: new Date().toISOString(), delivery, event, repo: req.body?.repository?.full_name ?? null, ref: null, outcome: 'ping', plans: [] });
    console.log(`[webhook] ping received (delivery=${delivery})`);
    return res.status(200).send('pong');
  }

  if (event !== 'push') {
    // An org-wide webhook receives every event type it's subscribed to; only push builds anything.
    recordEvent({ ts: new Date().toISOString(), delivery, event, repo: req.body?.repository?.full_name ?? null, ref: null, outcome: 'ignored_event', plans: [] });
    return res.status(200).send(`ignored event: ${event}`);
  }

  const payload = req.body;
  const repoFullName = payload?.repository?.full_name;
  const ref = payload?.ref;
  const deleted = payload?.deleted === true; // branch/tag deletion push - nothing to build
  const branch = branchFromRef(ref);

  if (!repoFullName) {
    recordEvent({ ts: new Date().toISOString(), delivery, event, repo: null, ref, outcome: 'ignored_no_repo', plans: [] });
    console.warn(`[webhook] push payload missing repository.full_name (delivery=${delivery})`);
    return res.status(200).send('ignored: no repository in payload');
  }

  stats.pushByRepo[repoFullName] = (stats.pushByRepo[repoFullName] || 0) + 1;

  const entry = recordEvent({
    ts: new Date().toISOString(),
    delivery,
    event,
    repo: repoFullName,
    ref: branch,
    outcome: deleted ? 'ignored_deleted' : 'received',
    plans: [],
  });

  // Acknowledge immediately; the Bamboo call(s) happen asynchronously below so a slow or
  // unreachable Bamboo instance never causes GitHub to record a timed-out delivery.
  res.status(202).send('accepted');

  if (deleted) {
    console.log(`[webhook] ignoring branch/tag deletion repo=${repoFullName} ref=${ref} (delivery=${delivery})`);
    return;
  }

  const rules = repoPlanMap[repoFullName];
  if (!rules || rules.length === 0) {
    entry.outcome = 'ignored_no_mapping';
    console.log(`[webhook] no plan mapping for repo=${repoFullName} (delivery=${delivery}) - ignoring`);
    return;
  }

  const meta = { repo: repoFullName, ref: branch };
  const pending = [];

  for (const rule of rules) {
    const planKey = typeof rule === 'string' ? rule : rule.planKey;
    const branches = typeof rule === 'string' ? null : rule.branches;
    if (!planKey) continue;
    const planEntry = { planKey, status: 'pending', detail: null };
    entry.plans.push(planEntry);
    if (branches && branches.length > 0 && !branches.includes(branch)) {
      planEntry.status = 'skipped_branch';
      planEntry.detail = `not in branch filter ${JSON.stringify(branches)}`;
      console.log(`[webhook] skip plan=${planKey} repo=${repoFullName} ref=${branch} (not in branch filter ${JSON.stringify(branches)})`);
      continue;
    }
    pending.push(triggerBambooPlan(planKey, meta, planEntry));
  }

  if (entry.plans.length === 0) {
    entry.outcome = 'ignored_no_mapping';
  } else {
    entry.outcome = 'dispatched';
    Promise.all(pending).then(() => { entry.outcome = 'done'; });
  }
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/api/status', (_req, res) => {
  res.json({
    version: VERSION,
    startedAt: stats.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    bambooBaseUrl: BAMBOO_BASE_URL,
    port: PORT,
    mapFile: MAP_FILE,
    repoPlanMap,
    stats: {
      received: stats.received,
      byEvent: stats.byEvent,
      pushByRepo: stats.pushByRepo,
      rejectedSignature: stats.rejectedSignature,
      triggered: stats.triggered,
      triggerFailed: stats.triggerFailed,
    },
    // Newest first, capped - this is a debugging aid, not a full audit trail.
    log: activityLog.slice().reverse(),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`bamboo-notifier listening on :${PORT}, bamboo=${BAMBOO_BASE_URL}, repos configured=${Object.keys(repoPlanMap).length}, version=${VERSION.hash}`);
});
