// SQLite-backed persistence for delivery/trigger history and the stats the dashboard
// shows. Uses Node's built-in `node:sqlite` (stable enough for this workload, and means
// no native-compiled dependency to build/ship - see AGENTS.md "prefer native modules").
//
// Every write is a synchronous statement against a single on-disk file (WAL journal mode,
// so reads from /api/status never block a concurrent write). There's no in-memory mirror
// to keep in sync or periodically flush - each call here is already durable when it returns.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    delivery_id TEXT,
    event TEXT,
    repo TEXT,
    ref TEXT,
    outcome TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_ts ON deliveries(ts);
  CREATE INDEX IF NOT EXISTS idx_deliveries_repo ON deliveries(repo);

  CREATE TABLE IF NOT EXISTS plan_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
    ts TEXT NOT NULL,
    plan_key TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plan_triggers_delivery ON plan_triggers(delivery_id);
  CREATE INDEX IF NOT EXISTS idx_plan_triggers_status ON plan_triggers(status);
`;

const FAILED_STATUSES = ['failed', 'error'];

/**
 * Opens (creating if needed) the SQLite database at `dbFile` and returns a small
 * repository-style API over it. `dbFile`'s parent directory is created if missing,
 * so callers can just point this at e.g. /app/data/bamboo-notifier.db.
 */
export function createStore(dbFile, { retentionDays = 0 } = {}) {
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmts = {
    insertDelivery: db.prepare(
      'INSERT INTO deliveries (ts, delivery_id, event, repo, ref, outcome) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    updateDeliveryOutcome: db.prepare('UPDATE deliveries SET outcome = ? WHERE id = ?'),
    insertPlanTrigger: db.prepare(
      'INSERT INTO plan_triggers (delivery_id, ts, plan_key, status, detail) VALUES (?, ?, ?, ?, ?)'
    ),
    updatePlanTrigger: db.prepare('UPDATE plan_triggers SET status = ?, detail = ? WHERE id = ?'),
    recentDeliveries: db.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    countReceived: db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE outcome != 'rejected_signature'"),
    countRejected: db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE outcome = 'rejected_signature'"),
    byEvent: db.prepare("SELECT event, COUNT(*) AS c FROM deliveries WHERE outcome != 'rejected_signature' AND event IS NOT NULL GROUP BY event"),
    pushByRepo: db.prepare("SELECT repo, COUNT(*) AS c FROM deliveries WHERE event = 'push' AND repo IS NOT NULL GROUP BY repo"),
    countTriggered: db.prepare("SELECT COUNT(*) AS c FROM plan_triggers WHERE status = 'triggered'"),
    countTriggerFailed: db.prepare(`SELECT COUNT(*) AS c FROM plan_triggers WHERE status IN (${FAILED_STATUSES.map(() => '?').join(',')})`),
    dailyDeliveries: db.prepare(`
      SELECT substr(ts, 1, 10) AS day,
             SUM(CASE WHEN outcome != 'rejected_signature' THEN 1 ELSE 0 END) AS received,
             SUM(CASE WHEN outcome = 'rejected_signature' THEN 1 ELSE 0 END) AS rejectedSignature
      FROM deliveries
      GROUP BY day ORDER BY day DESC LIMIT ?
    `),
    dailyTriggers: db.prepare(`
      SELECT substr(ts, 1, 10) AS day,
             SUM(CASE WHEN status = 'triggered' THEN 1 ELSE 0 END) AS triggered,
             SUM(CASE WHEN status IN (${FAILED_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS triggerFailed
      FROM plan_triggers
      GROUP BY day ORDER BY day DESC LIMIT ?
    `),
    deleteOldPlanTriggers: db.prepare('DELETE FROM plan_triggers WHERE delivery_id IN (SELECT id FROM deliveries WHERE ts < ?)'),
    deleteOldDeliveries: db.prepare('DELETE FROM deliveries WHERE ts < ?'),
  };

  function recordDelivery({ ts, delivery, event, repo, ref, outcome }) {
    const { lastInsertRowid } = stmts.insertDelivery.run(ts, delivery ?? null, event ?? null, repo ?? null, ref ?? null, outcome);
    return lastInsertRowid;
  }

  function updateDeliveryOutcome(id, outcome) {
    stmts.updateDeliveryOutcome.run(outcome, id);
  }

  function addPlanTrigger(deliveryId, planKey, status = 'pending', detail = null) {
    const { lastInsertRowid } = stmts.insertPlanTrigger.run(deliveryId, new Date().toISOString(), planKey, status, detail);
    return lastInsertRowid;
  }

  function updatePlanTrigger(id, status, detail = null) {
    stmts.updatePlanTrigger.run(status, detail, id);
  }

  function getRecentActivity(limit) {
    const rows = stmts.recentDeliveries.all(limit);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const planRows = db.prepare(`SELECT * FROM plan_triggers WHERE delivery_id IN (${placeholders}) ORDER BY id ASC`).all(...ids);
    const plansByDelivery = new Map();
    for (const p of planRows) {
      const list = plansByDelivery.get(p.delivery_id) ?? [];
      list.push({ planKey: p.plan_key, status: p.status, detail: p.detail });
      plansByDelivery.set(p.delivery_id, list);
    }
    return rows.map((r) => ({
      ts: r.ts,
      delivery: r.delivery_id,
      event: r.event,
      repo: r.repo,
      ref: r.ref,
      outcome: r.outcome,
      plans: plansByDelivery.get(r.id) ?? [],
    }));
  }

  function getStats() {
    return {
      received: stmts.countReceived.get().c,
      byEvent: Object.fromEntries(stmts.byEvent.all().map((r) => [r.event, r.c])),
      pushByRepo: Object.fromEntries(stmts.pushByRepo.all().map((r) => [r.repo, r.c])),
      rejectedSignature: stmts.countRejected.get().c,
      triggered: stmts.countTriggered.get().c,
      triggerFailed: stmts.countTriggerFailed.get(...FAILED_STATUSES).c,
    };
  }

  function getDailyStats(days = 14) {
    const byDay = new Map();
    for (const r of stmts.dailyDeliveries.all(days)) {
      byDay.set(r.day, { day: r.day, received: r.received, rejectedSignature: r.rejectedSignature, triggered: 0, triggerFailed: 0 });
    }
    for (const r of stmts.dailyTriggers.all(...FAILED_STATUSES, days)) {
      const existing = byDay.get(r.day) ?? { day: r.day, received: 0, rejectedSignature: 0 };
      existing.triggered = r.triggered;
      existing.triggerFailed = r.triggerFailed;
      byDay.set(r.day, existing);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days);
  }

  // `startedAt` historically means "first time this service was ever started", not
  // "when this process booted" - persisted once so it survives restarts.
  function getOrSetStartedAt() {
    const existing = stmts.getMeta.get('started_at');
    if (existing) return existing.value;
    const now = new Date().toISOString();
    stmts.setMeta.run('started_at', now);
    return now;
  }

  function pruneOldRows() {
    if (!retentionDays || retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    stmts.deleteOldPlanTriggers.run(cutoff);
    stmts.deleteOldDeliveries.run(cutoff);
  }

  function close() {
    db.close();
  }

  return {
    dbFile,
    recordDelivery,
    updateDeliveryOutcome,
    addPlanTrigger,
    updatePlanTrigger,
    getRecentActivity,
    getStats,
    getDailyStats,
    getOrSetStartedAt,
    pruneOldRows,
    close,
  };
}
