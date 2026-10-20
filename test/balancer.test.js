'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const balancer = require('../src/core/balancer');
const { execute } = require('../src/core/executor');
const { run } = require('../src/core/runner');
const { newRequestDef, newCollection, newRequestItem } = require('../src/core/model');

// Three instances of one service; the third is slow. Each names itself in X-Served-By.
async function startInstances() {
  const servers = await Promise.all(['a', 'b', 'c'].map((name) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(name === 'b' && req.url === '/fail' ? 503 : 200, { 'Content-Type': 'application/json', 'X-Served-By': `pod-${name}` });
        res.end(JSON.stringify({ name, auth: req.headers['x-target'] || null }));
      }, name === 'c' ? 120 : 5);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  return { servers, urls, close: () => servers.forEach((s) => s.close()) };
}

const poolFor = (urls, extra = {}) => ({
  orders_url: { sourceId: 'src1', service: 'orders', strategy: 'round-robin', header: '', default: urls[0], instances: urls.map((url, i) => ({ id: `orders-${i + 1}`, url, healthy: true })), ...extra },
});
const scopes = (urls, extra) => ({ globals: {}, collection: {}, environment: { orders_url: urls[0], other: 'x' }, data: {}, pools: poolFor(urls, extra) });

test('round robin spreads requests and records the instance each one went to', async () => {
  const inst = await startInstances();
  balancer.reset('src1');
  try {
    const seen = [];
    for (let i = 0; i < 6; i++) {
      // The URL and a header both use the variable: one request, one instance.
      const res = await execute({ request: newRequestDef({ url: '{{orders_url}}/orders', headers: [{ key: 'X-Target', value: '{{orders_url}}', enabled: true }] }), scopes: scopes(inst.urls) });
      const body = JSON.parse(res.response.bodyText);
      assert.strictEqual(res.routing.length, 1);
      assert.strictEqual(res.routing[0].instance, inst.urls[['a', 'b', 'c'].indexOf(body.name)]);
      assert.strictEqual(body.auth, res.routing[0].instance);
      seen.push(body.name);
    }
    assert.deepStrictEqual(seen, ['a', 'b', 'c', 'a', 'b', 'c']);
    const m = balancer.metrics('src1');
    assert.deepStrictEqual(m.rows.map((r) => [r.instanceId, r.requests, r.status['2xx']]), [['orders-1', 2, 2], ['orders-2', 2, 2], ['orders-3', 2, 2]]);
    const slow = m.rows.find((r) => r.instanceId === 'orders-3');
    assert.ok(slow.p50 >= 100, `the slow instance's p50 is ${slow.p50}`);
    assert.ok(m.rows.find((r) => r.instanceId === 'orders-1').p50 < 100);
  } finally { inst.close(); }
});

test('only requests that use the variable take a turn; an overridden value is used as is', async () => {
  const inst = await startInstances();
  balancer.reset('src1');
  try {
    const unused = await execute({ request: newRequestDef({ url: `${inst.urls[2]}/x` }), scopes: scopes(inst.urls) });
    assert.strictEqual(unused.routing, undefined);
    const first = await execute({ request: newRequestDef({ url: '{{orders_url}}/x' }), scopes: scopes(inst.urls) });
    assert.strictEqual(JSON.parse(first.response.bodyText).name, 'a', 'the rotation started at the first instance');
    // A pre-request script setting the variable wins over the pool.
    const scripted = await execute({
      request: newRequestDef({ url: '{{orders_url}}/x', preRequestScript: `pm.environment.set('orders_url', '${inst.urls[2]}')` }),
      scopes: scopes(inst.urls),
    });
    assert.strictEqual(JSON.parse(scripted.response.bodyText).name, 'c');
    assert.strictEqual(scripted.routing, undefined);
  } finally { inst.close(); }
});

test('unhealthy instances are skipped; the header names who answered; errors are counted', async () => {
  const inst = await startInstances();
  balancer.reset('src1');
  try {
    const sc = scopes(inst.urls, { header: 'x-served-by' });
    sc.pools.orders_url.instances[2].healthy = false;
    const names = [];
    for (let i = 0; i < 4; i++) {
      const res = await execute({ request: newRequestDef({ url: '{{orders_url}}/fail' }), scopes: sc });
      names.push(res.routing[0].servedBy);
    }
    assert.deepStrictEqual(names, ['pod-a', 'pod-b', 'pod-a', 'pod-b']);
    const rows = balancer.metrics('src1').rows;
    assert.deepStrictEqual(rows.map((r) => [r.servedBy, r.status['2xx'], r.status['5xx']]), [['pod-a', 2, 0], ['pod-b', 0, 2]]);
    // An instance that can't be reached counts as an error.
    const down = await execute({ request: newRequestDef({ url: '{{orders_url}}/x' }), scopes: { ...sc, pools: poolFor(['http://127.0.0.1:1'], { sourceId: 'src2' }), environment: { orders_url: 'http://127.0.0.1:1' } } });
    assert.ok(down.error);
    assert.strictEqual(balancer.metrics('src2').rows[0].errors, 1);
    balancer.reset('src2');
  } finally { inst.close(); }
});

test('a collection run sums its own traffic by instance', async () => {
  const inst = await startInstances();
  balancer.reset('src1');
  try {
    const col = newCollection('Orders');
    col.items.push(newRequestItem('List', { url: '{{orders_url}}/orders' }), newRequestItem('Other', { url: `${inst.urls[0]}/no-pool` }));
    const summary = await run({ collection: col, scopes: { globals: {}, environment: { orders_url: inst.urls[0] }, pools: poolFor(inst.urls) }, iterations: 6 });
    assert.strictEqual(summary.requests, 12);
    assert.deepStrictEqual(summary.instances.map((r) => [r.instanceId, r.requests]), [['orders-1', 2], ['orders-2', 2], ['orders-3', 2]]);
    assert.ok(summary.results[0].routing[0].instance);
    assert.strictEqual(summary.results[1].routing, undefined);
  } finally { inst.close(); }
});

test('random and first strategies', () => {
  const pool = { sourceId: 's', service: 'x', default: 'http://d', instances: [{ url: 'http://a' }, { url: 'http://b' }] };
  assert.strictEqual(balancer.pick('v', { ...pool, strategy: 'first' }).url, 'http://d');
  const got = new Set(Array.from({ length: 50 }, () => balancer.pick('v', { ...pool, strategy: 'random' }).url));
  assert.deepStrictEqual([...got].sort(), ['http://a', 'http://b']);
});
