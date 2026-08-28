import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.BAMBOO_TOKEN = 'test-bamboo-token';
process.env.BAMBOO_BASE_URL = 'https://bamboo.test';
process.env.REPO_PLAN_MAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'repo-plan-map.example.json');
process.env.BAMBOO_TIMEOUT_MS = '1000';
// Use a throwaway db file so this run's history/stats never leak into (or get polluted
// by) the real data/bamboo-notifier.db - that file persists across CI runs on the Bamboo
// agent's build directory since data/ is gitignored and never cleaned between builds.
process.env.DB_FILE = path.join(os.tmpdir(), `bamboo-notifier-test-${process.pid}.db`);

const { app, branchFromRef, verifySignature, store, DB_FILE } = await import('../server.js');


let server;
let bambooResponse = { status: 200, body: { buildResultKey: 'EX-123' } };
const bambooRequests = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  bambooRequests.push({ url, options });
  const response = bambooResponse;
  const responseBody = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  return new Response(responseBody, {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
};

before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

function request(method, requestPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const requestHeaders = { ...headers };
    if (body !== undefined) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path: requestPath,
      headers: requestHeaders,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function signedWebhook(event, payload, delivery = `delivery-${Date.now()}-${Math.random()}`) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex')}`;
  return request('POST', '/webhook/github', {
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': delivery,
      'x-github-event': event,
      'x-hub-signature-256': signature,
    },
  });
}

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await condition(), 'condition was not met before the timeout');
}

const pushPayload = (repo, ref = 'refs/heads/main', extra = {}) => ({
  repository: { full_name: repo },
  ref,
  deleted: false,
  ...extra,
});

test('branchFromRef removes heads prefix and preserves other refs', () => {
  assert.equal(branchFromRef('refs/heads/main'), 'main');
  assert.equal(branchFromRef('refs/tags/v1.0.0'), 'refs/tags/v1.0.0');
  assert.equal(branchFromRef(undefined), undefined);
});

test('verifySignature accepts the matching HMAC and rejects invalid input', () => {
  const rawBody = Buffer.from('{"hello":"world"}');
  const signature = `sha256=${crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
  const requestWith = (value) => ({ rawBody, get: () => value });

  assert.equal(verifySignature(requestWith(signature)), true);
  assert.equal(verifySignature(requestWith(`${signature.slice(0, -1)}0`)), false);
  assert.equal(verifySignature({ rawBody, get: () => undefined }), false);
});

test('health check responds without webhook authentication', async () => {
  const response = await request('GET', '/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'ok');
});

test('rejects a webhook with an invalid signature', async () => {
  const response = await request('POST', '/webhook/github', {
    body: '{}',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-hub-signature-256': 'sha256=invalid',
    },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body, 'invalid signature');
});

test('responds to a signed ping without triggering Bamboo', async () => {
  const requestCount = bambooRequests.length;
  const response = await signedWebhook('ping', {
    repository: { full_name: 'myorg/example-service' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body, 'pong');
  assert.equal(bambooRequests.length, requestCount);
});

test('acknowledges and ignores non-push events', async () => {
  const response = await signedWebhook('issues', {
    repository: { full_name: 'myorg/example-service' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body, 'ignored event: issues');
});

test('ignores deleted pushes without triggering Bamboo', async () => {
  const requestCount = bambooRequests.length;
  const response = await signedWebhook('push', pushPayload('myorg/example-service', 'refs/heads/main', { deleted: true }));

  assert.equal(response.status, 202);
  assert.equal(response.body, 'accepted');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bambooRequests.length, requestCount);
});

test('ignores pushes for repositories without a plan mapping', async () => {
  const response = await signedWebhook('push', pushPayload('myorg/unmapped-repository'));

  assert.equal(response.status, 202);
  await waitFor(async () => {
    const status = await request('GET', '/api/status');
    return JSON.parse(status.body).log[0]?.outcome === 'ignored_no_mapping';
  });
});

test('skips a mapped plan when the branch filter does not match', async () => {
  const requestCount = bambooRequests.length;
  const response = await signedWebhook('push', pushPayload('myorg/example-service', 'refs/heads/feature'));

  assert.equal(response.status, 202);
  await waitFor(async () => {
    const status = await request('GET', '/api/status');
    const entry = JSON.parse(status.body).log[0];
    return entry?.outcome === 'done' && entry.plans[0]?.status === 'skipped_branch';
  });
  assert.equal(bambooRequests.length, requestCount);
});

test('triggers a mapped plan and records the Bamboo build result', async () => {
  bambooResponse = { status: 200, body: { buildResultKey: 'EX-456' } };
  const response = await signedWebhook('push', pushPayload('myorg/example-service'));

  assert.equal(response.status, 202);
  await waitFor(async () => {
    const status = await request('GET', '/api/status');
    const data = JSON.parse(status.body);
    return data.log[0]?.outcome === 'done' && data.log[0]?.plans[0]?.status === 'triggered';
  });

  const lastRequest = bambooRequests.at(-1);
  assert.equal(lastRequest.url, 'https://bamboo.test/rest/api/latest/queue/EX-EX.json');
  assert.equal(lastRequest.options.method, 'POST');
  assert.equal(lastRequest.options.headers.Authorization, 'Bearer test-bamboo-token');
});

test('records a failed Bamboo response', async () => {
  bambooResponse = { status: 503, body: 'Bamboo unavailable' };
  const response = await signedWebhook('push', pushPayload('myorg/another-repo', 'refs/heads/main'));

  assert.equal(response.status, 202);
  await waitFor(async () => {
    const status = await request('GET', '/api/status');
    const data = JSON.parse(status.body);
    return data.log[0]?.outcome === 'done' && data.log[0]?.plans[0]?.status === 'failed';
  });

  const status = await request('GET', '/api/status');
  const data = JSON.parse(status.body);
  assert.equal(data.log[0].plans[0].detail, 'HTTP 503: Bamboo unavailable');
  assert.equal(data.stats.triggerFailed, 1);
});

test('persists history and stats to the SQLite database on disk', async () => {
  // Every recordDelivery/updatePlanTrigger call in server.js is a synchronous SQLite
  // write, so by the time earlier tests' waitFor() resolved, it was already durable -
  // no explicit flush needed here.
  assert.equal(fs.existsSync(DB_FILE), true);
  const stats = store.getStats();
  assert.ok(stats.received > 0);
  assert.ok(Array.isArray(store.getRecentActivity(10)));
  assert.ok(Array.isArray(store.getDailyStats(14)));
});

