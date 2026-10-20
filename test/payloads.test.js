'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const payloads = require('../src/core/payloads');
const balancer = require('../src/core/balancer');
const { execute } = require('../src/core/executor');
const { run } = require('../src/core/runner');
const { newRequestDef, newCollection, newRequestItem } = require('../src/core/model');

// Echoes the path and the body it got.
function echo() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: req.url, body, type: req.headers['content-type'] || null })); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const orderPayloads = (mode) => ({
  mode,
  items: [
    { id: 'p1', name: 'small order', enabled: true, body: '{"order":"{{orderId}}","qty":1}', variables: [{ key: 'orderId', value: 'ORD-1', enabled: true }] },
    { id: 'p2', name: 'big order', enabled: true, body: '{"order":"{{orderId}}","qty":500}', variables: [{ key: 'orderId', value: 'ORD-2', enabled: true }] },
    { id: 'p3', name: 'switched off', enabled: false, body: 'nope', variables: [] },
    { id: 'p4', name: 'only a variable', enabled: true, body: '', variables: [{ key: 'orderId', value: 'ORD-4', enabled: true }] },
  ],
});

test('each payload in turn: its body and variables, skipping disabled ones', async () => {
  const server = await echo();
  payloads.reset();
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = newRequestDef({ method: 'POST', url: `${url}/orders/{{orderId}}`, body: { mode: 'raw', raw: '{"order":"{{orderId}}","qty":0}', rawLanguage: 'json' }, payloads: orderPayloads('sequence') });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const res = await execute({ request, scopes: { globals: {}, collection: {}, environment: { orderId: 'ENV' }, data: {} }, info: { requestId: 'r1' } });
      const got = JSON.parse(res.response.bodyText);
      seen.push([res.payload.name, got.path, got.body]);
    }
    assert.deepStrictEqual(seen, [
      ['small order', '/orders/ORD-1', '{"order":"ORD-1","qty":1}'],
      ['big order', '/orders/ORD-2', '{"order":"ORD-2","qty":500}'],
      ['only a variable', '/orders/ORD-4', '{"order":"ORD-4","qty":0}'], // no body of its own: the request's, with its variable
      ['small order', '/orders/ORD-1', '{"order":"ORD-1","qty":1}'],
    ]);
    // Off: the request as it is. A forced payload works even then.
    const off = await execute({ request: { ...request, payloads: orderPayloads('off') }, scopes: { globals: {}, collection: {}, environment: { orderId: 'ENV' }, data: {} }, info: { requestId: 'r2' } });
    assert.strictEqual(off.payload, undefined);
    assert.strictEqual(JSON.parse(off.response.bodyText).path, '/orders/ENV');
    const forced = await execute({ request: { ...request, payloads: orderPayloads('off') }, scopes: { globals: {}, collection: {}, environment: {}, data: {} }, info: { requestId: 'r2', payloadIndex: 1 } });
    assert.strictEqual(forced.payload.name, 'big order');
    assert.match(JSON.parse(forced.response.bodyText).body, /"qty":500/);
  } finally { server.close(); }
});

test('random picks only enabled payloads', () => {
  const req = { payloads: orderPayloads('random') };
  const names = new Set(Array.from({ length: 60 }, () => payloads.choose(req, { key: 'x' }).item.name));
  assert.deepStrictEqual([...names].sort(), ['big order', 'only a variable', 'small order']);
});

test('rows from a data file become payloads', () => {
  const out = payloads.fromRows([{ name: 'vip', body: { qty: 9 }, orderId: 'A1', tags: ['x'] }, { orderId: 'B2', body: '' }]);
  assert.deepStrictEqual(out, [
    { name: 'vip', enabled: true, body: '{\n  "qty": 9\n}', variables: [{ key: 'orderId', value: 'A1', enabled: true }, { key: 'tags', value: '["x"]', enabled: true }] },
    { name: 'Row 2', enabled: true, body: '', variables: [{ key: 'orderId', value: 'B2', enabled: true }] },
  ]);
});

test('a run starts from the first payload; results and traffic say which payload was sent', async () => {
  const server = await echo();
  balancer.reset('s1');
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const col = newCollection('Orders');
    col.items.push(newRequestItem('Create order', { method: 'POST', url: '{{orders_url}}/orders/{{orderId}}', payloads: orderPayloads('sequence') }));
    const scopes = () => ({ globals: {}, environment: { orders_url: url }, pools: { orders_url: { sourceId: 's1', service: 'orders', strategy: 'first', default: url, instances: [{ id: 'o1', url }] } } });
    const first = await run({ collection: col, scopes: scopes(), iterations: 2, resetPayloads: true });
    const second = await run({ collection: col, scopes: scopes(), iterations: 2, resetPayloads: true });
    assert.deepStrictEqual(first.results.map((r) => r.payload.name), ['small order', 'big order']);
    assert.deepStrictEqual(second.results.map((r) => r.payload.name), ['small order', 'big order']);
    const m = balancer.metrics('s1');
    assert.deepStrictEqual(m.byPayload.map((r) => [r.payload, r.requests]).sort(), [['big order', 2], ['small order', 2]]);
    assert.strictEqual(m.recent[0].payload, 'big order');
  } finally { server.close(); }
});

test('every payload meets every instance: payload and instance rotations do not move in step', async () => {
  const servers = await Promise.all([1, 2, 3].map(() => echo()));
  payloads.reset();
  balancer.reset('s2');
  try {
    const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
    const request = newRequestDef({ url: '{{orders_url}}/orders/{{orderId}}', payloads: { mode: 'sequence', items: ['A', 'B', 'C'].map((n) => ({ id: n, name: n, enabled: true, variables: [{ key: 'orderId', value: n, enabled: true }] })) } });
    const pool = { orders_url: { sourceId: 's2', service: 'orders', strategy: 'round-robin', default: urls[0], instances: urls.map((url, i) => ({ id: `o${i + 1}`, url })) } };
    const pairs = new Set();
    for (let i = 0; i < 9; i++) {
      const res = await execute({ request, scopes: { globals: {}, collection: {}, environment: { orders_url: urls[0] }, data: {}, pools: pool }, info: { requestId: 'lockstep' } });
      pairs.add(`${res.payload.name}@${res.routing[0].instanceId}`);
    }
    assert.strictEqual(pairs.size, 9, `all 3x3 combinations: ${[...pairs].join(' ')}`);
    assert.deepStrictEqual(balancer.metrics('s2').rows.map((r) => r.requests), [3, 3, 3]);
  } finally { servers.forEach((s) => s.close()); }
});
