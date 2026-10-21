'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const health = require('../src/core/health');
const { execute } = require('../src/core/executor');
const runner = require('../src/core/runner');
const { newCollection, newRequestItem, newFolder } = require('../src/core/model');

// A service whose health endpoint counts the requests it is working on.
let server;
let base;
let inflight = 0;
let down = false;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/healthz')) {
      res.writeHead(down ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !down, db: { state: down ? 'down' : 'up', transactions: { holding: inflight, waiting: 0 } }, build: 'b1', auth: req.headers.authorization || null }));
      return;
    }
    if (req.url.startsWith('/slow')) {
      inflight++;
      setTimeout(() => { inflight--; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"done":true}'); }, 300);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const scopes = () => ({ globals: {}, collection: {}, environment: { base }, data: {} });

test('the health config is inherited from the nearest folder, then the collection', () => {
  const col = { health: { mode: 'enabled', url: '/healthz' } };
  const folder = { health: { mode: 'inherit' } };
  assert.strictEqual(health.effectiveHealth({ health: { mode: 'inherit' } }, [col, folder]).url, '/healthz');
  assert.strictEqual(health.effectiveHealth({ health: { mode: 'none' } }, [col, folder]), null);
  assert.strictEqual(health.effectiveHealth({}, [col, { health: { mode: 'enabled', url: '/ready' } }]).url, '/ready');
  assert.strictEqual(health.effectiveHealth({}, [{ health: { mode: 'enabled', url: '  ' } }]), null, 'no URL, no health check');
});

test('a path is read on the request\'s own host; a full URL as written, with variables', () => {
  assert.strictEqual(health.healthUrl({ url: '/healthz' }, {}, 'http://orders-2:7002/orders/1?x=1'), 'http://orders-2:7002/healthz');
  assert.strictEqual(health.healthUrl({ url: '{{mes}}/healthz' }, { mes: 'http://mes:9090' }, 'http://other/'), 'http://mes:9090/healthz');
});

test('healthy is judged by the status, then ok, healthy or status in the body', () => {
  assert.strictEqual(health.judge(200, { ok: true }), true);
  assert.strictEqual(health.judge(200, { ok: false }), false);
  assert.strictEqual(health.judge(200, { status: 'UP' }), true);
  assert.strictEqual(health.judge(200, { status: 'DOWN' }), false);
  assert.strictEqual(health.judge(200, { status: 'pass' }), true);
  assert.strictEqual(health.judge(503, { ok: true }), false);
  assert.strictEqual(health.judge(200, undefined), true);
});

test('health is read before, during and after a request, and what moved is listed first', async () => {
  const req = newRequestItem('Slow', { url: '{{base}}/slow' });
  const col = newCollection('Svc');
  const folder = newFolder('Orders');
  folder.health = { mode: 'enabled', url: '/healthz', intervalMs: 50 };
  folder.items.push(req);
  col.items.push(folder);
  const res = await execute({ request: req.request, chain: [col, folder], scopes: scopes(), settings: {} });
  assert.strictEqual(res.response.status, 200);
  const h = res.health;
  assert.ok(h, 'a health result');
  assert.strictEqual(h.url, `${base}/healthz`);
  assert.ok(h.ok);
  const phases = h.samples.map((s) => s.phase);
  assert.strictEqual(phases[0], 'before');
  assert.strictEqual(phases[phases.length - 1], 'after');
  assert.ok(phases.filter((p) => p === 'during').length >= 2, `readings during the request: ${phases.join(',')}`);
  assert.ok(h.samples[0].t <= 0, 'the reading before is timed before the request was sent');
  const holding = h.fields.find((f) => f.path === 'db.transactions.holding');
  assert.deepStrictEqual({ before: holding.before, max: holding.max, after: holding.after, changed: holding.changed }, { before: 0, max: 1, after: 0, changed: true });
  assert.strictEqual(h.fields[0].path, 'db.transactions.holding', 'fields that moved come first');
  assert.strictEqual(h.fields.find((f) => f.path === 'build').changed, false);
  assert.ok(h.samples.every((s) => !('build' in s.values)), 'samples keep only the fields that moved');
  assert.match(health.describe(h), /^healthy throughout; db\.transactions\.holding 0 → 1 → 0$/);
});

test('an unhealthy service is reported, and the request still goes through', async () => {
  down = true;
  try {
    const req = newRequestItem('Slow', { url: '{{base}}/slow', health: { mode: 'enabled', url: '{{base}}/healthz', intervalMs: 100 } });
    const res = await execute({ request: req.request, chain: [], scopes: scopes(), settings: {} });
    assert.strictEqual(res.response.status, 200);
    assert.strictEqual(res.health.ok, false);
    assert.strictEqual(res.health.unhealthy, res.health.samples.length);
    assert.strictEqual(res.health.samples[0].status, 503);
  } finally { down = false; }
});

test('only the watched fields are kept, and the Authorization header is sent only when asked', async () => {
  const req = newRequestItem('Slow', {
    url: '{{base}}/slow', auth: { type: 'bearer', bearer: { token: 't0k' } },
    health: { mode: 'enabled', url: '/healthz', intervalMs: 100, watch: ['db.transactions', 'auth'] },
  });
  let res = await execute({ request: req.request, chain: [], scopes: scopes(), settings: {} });
  assert.deepStrictEqual(res.health.fields.map((f) => f.path).sort(), ['auth', 'db.transactions.holding', 'db.transactions.waiting']);
  assert.strictEqual(res.health.fields.find((f) => f.path === 'auth').before, null);
  req.request.health.sendAuth = true;
  res = await execute({ request: req.request, chain: [], scopes: scopes(), settings: {} });
  assert.strictEqual(res.health.fields.find((f) => f.path === 'auth').before, 'Bearer t0k');
});

test('a health endpoint that cannot be reached is an unhealthy reading, not a failed request', async () => {
  const req = newRequestItem('Slow', { url: '{{base}}/slow', health: { mode: 'enabled', url: 'http://127.0.0.1:1/healthz', intervalMs: 100 } });
  const res = await execute({ request: req.request, chain: [], scopes: scopes(), settings: {} });
  assert.strictEqual(res.response.status, 200);
  assert.strictEqual(res.health.ok, false);
  assert.ok(res.health.samples[0].error);
});

test('the runner keeps each request\'s health', async () => {
  const col = newCollection('Svc');
  col.health = { mode: 'enabled', url: '/healthz', intervalMs: 50 };
  col.items.push(newRequestItem('Slow', { url: '{{base}}/slow' }));
  const summary = await runner.run({ collection: col, scopes: scopes(), settings: {} });
  assert.ok(summary.results[0].health);
  assert.ok(summary.results[0].health.fields.some((f) => f.path === 'db.transactions.holding' && f.changed));
});
