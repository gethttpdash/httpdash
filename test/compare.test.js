'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compare } = require('../src/core/compare');

const answer = (instance, body, { status = 200, headers = [], time = 20 } = {}) => ({
  instance: `http://10.0.0.${instance}:8080`, instanceId: `orders-${instance}`,
  response: { status, headers: [['Content-Type', 'application/json'], ['Date', `Tue, 21 Oct 2026 04:5${instance}:00 GMT`], ['X-Served-By', `orders-${instance}`], ...headers], bodyText: JSON.stringify(body), time },
  error: null, tests: [{ passed: true }],
});
const order = (extra = {}) => ({ id: 'ORD-1001', state: 'released', qty: 20, served: 'x', items: [{ sku: 'A', price: 1.5 }, { sku: 'B', price: 2 }], ...extra });

test('the odd one out is found; noise and per-instance values are told apart', () => {
  const results = [
    answer(1, order({ served: 'orders-1', at: '04:51:00' }), { headers: [['X-Version', '2.4.1']] }),
    answer(2, order({ served: 'orders-2', at: '04:52:00' }), { headers: [['X-Version', '2.4.1']] }),
    answer(3, order({ served: 'orders-3', at: '04:53:00', state: 'planned', qty: undefined, items: [{ sku: 'A', price: 1.75 }, { sku: 'B', price: 2 }] }), { headers: [['X-Version', '2.3.0']] }),
  ];
  const { differences, instances, baseline } = compare(results);
  const odd = differences.filter((d) => d.kind === 'odd');
  assert.deepStrictEqual(odd.map((d) => d.key), ['header:x-version', 'body:items[0].price', 'body:qty', 'body:state']);
  for (const d of odd) assert.deepStrictEqual(d.odd, ['http://10.0.0.3:8080']);
  assert.strictEqual(odd.find((d) => d.key === 'body:qty').values[2].value, '(missing)');
  assert.strictEqual(odd.find((d) => d.key === 'body:state').majority, '"released"');
  // Every instance has its own: probably expected. Date and X-Served-By aren't compared at all.
  assert.deepStrictEqual(differences.filter((d) => d.kind === 'varies').map((d) => d.key), ['body:at', 'body:served']);
  assert.ok(!differences.some((d) => /date|served-by/.test(d.key)));
  assert.deepStrictEqual(instances.map((i) => i.odd), [0, 0, 4]);
  assert.strictEqual(baseline, 0);
});

test('ignored headers and paths, with [*] for any array index', () => {
  const results = [answer(1, order({ items: [{ sku: 'A', updatedAt: 1 }] })), answer(2, order({ items: [{ sku: 'A', updatedAt: 2 }] })), answer(3, order({ items: [{ sku: 'A', updatedAt: 3 }] }))];
  assert.deepStrictEqual(compare(results).differences.map((d) => d.key), ['body:items[0].updatedAt']);
  assert.deepStrictEqual(compare(results, { ignorePaths: ['items[*].updatedAt'] }).differences, []);
  const withHeader = results.map((r, i) => ({ ...r, response: { ...r.response, headers: [...r.response.headers, ['X-Pod', `p${i}`]] } }));
  assert.ok(compare(withHeader, { ignorePaths: ['items'] }).differences.some((d) => d.key === 'header:x-pod'));
  assert.deepStrictEqual(compare(withHeader, { ignorePaths: ['items'], ignoreHeaders: ['X-Pod'] }).differences, []);
});

test('two instances can only split; errors, statuses, array lengths and text bodies are compared', () => {
  const two = compare([answer(1, order()), answer(2, order({ qty: 21 }))]);
  assert.deepStrictEqual(two.differences.map((d) => [d.key, d.kind]), [['body:qty', 'split']]);

  const down = { instance: 'http://10.0.0.4:8080', instanceId: 'orders-4', response: null, error: 'connect ECONNREFUSED', tests: [] };
  const mixed = compare([answer(1, order()), answer(2, order()), answer(3, order(), { status: 503 }), down]);
  assert.deepStrictEqual(mixed.differences.slice(0, 2).map((d) => [d.key, d.kind, d.odd]), [
    ['error', 'odd', ['http://10.0.0.4:8080']],
    ['status', 'odd', ['http://10.0.0.3:8080', 'http://10.0.0.4:8080']],
  ]);
  const shorter = compare([answer(1, order()), answer(2, order()), answer(3, order({ items: [{ sku: 'A', price: 1.5 }] }))]);
  assert.ok(shorter.differences.some((d) => d.key === 'body:items.length' && d.kind === 'odd'));

  const text = (i, t) => ({ ...answer(i, {}), response: { status: 200, headers: [], bodyText: t, time: 1 } });
  assert.deepStrictEqual(compare([text(1, 'ok'), text(2, 'ok'), text(3, 'ok!')]).differences.map((d) => [d.key, d.kind]), [['body', 'odd']]);
  assert.deepStrictEqual(compare([answer(1, order()), answer(2, order()), answer(3, order())]).differences, []);
});

test('values made at answer time never single out an instance, but business dates do', () => {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 1000).toISOString();
  const results = [
    answer(1, order({ servedAt: earlier, requestId: '3f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6', shipBy: '2026-11-02' })),
    answer(2, order({ servedAt: now, requestId: '3f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6', shipBy: '2026-11-02' })),
    answer(3, order({ servedAt: now, requestId: '9a8b7c6d-1b2c-4d5e-8f90-a1b2c3d4e5f6', shipBy: '2026-10-30' })),
  ];
  const kinds = Object.fromEntries(compare(results).differences.map((d) => [d.key, d.kind]));
  assert.deepStrictEqual(kinds, { 'body:requestId': 'varies', 'body:servedAt': 'varies', 'body:shipBy': 'odd' });
});
