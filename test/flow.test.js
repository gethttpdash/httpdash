'use strict';

const test = require('node:test');
const assert = require('node:assert');
const flow = require('../src/core/flow');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.server.close());

const node = (id, type, label, extra = {}) => ({ id, type, label, x: 0, y: 0, ...extra });
const edge = (from, to, port = 'out') => ({ id: `${from}-${port}-${to}`, from, to, port });
const req = (method, url, extra = {}) => ({ method, url, headers: [], params: [], body: { mode: 'none' }, auth: { type: 'none' }, ...extra });

test('a flow must have one Start, chosen requests, valid connections and no loops', () => {
  const ok = { nodes: [node('s', 'start', 'Start'), node('e', 'end', 'End')], edges: [edge('s', 'e')] };
  assert.deepStrictEqual(flow.validate(ok), []);
  assert.match(flow.validate({ nodes: [node('e', 'end', 'End')], edges: [] }).join(' '), /Add a Start node/);
  assert.match(flow.validate({ nodes: [node('s', 'start', 'Start'), node('x', 'execute', 'Login')], edges: [edge('s', 'x')] }).join(' '), /"Login" has no request/);
  const loop = { nodes: [node('s', 'start', 'Start'), node('a', 'condition', 'A'), node('b', 'condition', 'B')], edges: [edge('s', 'a'), edge('a', 'b', 'true'), edge('b', 'a', 'true')] };
  assert.match(flow.validate(loop).join(' '), /loop/);
  assert.match(flow.validate({ nodes: [node('s', 'start', 'Start'), node('a', 'end', 'End')], edges: [edge('a', 's')] }).join(' '), /into Start/);
});

test('node keys come from labels, unique in the flow', () => {
  const keys = flow.nodeKeys({ nodes: [node('a', 'execute', 'Log in'), node('b', 'execute', 'Log in'), node('c', 'condition', '')] });
  assert.deepStrictEqual(keys, { a: 'log_in', b: 'log_in_2', c: 'condition' });
});

test('values pass from node to node, conditions choose a branch, and the other branch is skipped', async () => {
  const f = {
    nodes: [
      node('s', 'start', 'Start', { inputs: [{ key: 'user', value: 'ada' }] }),
      node('login', 'execute', 'Login', { requestId: 'r1', outputs: [{ name: 'token', path: 'headers.x-echo-token' }, { name: 'who', path: 'query.user' }] }),
      node('ok', 'condition', 'Logged in?', { rules: [{ left: '{{login.status}}', op: 'equals', right: '200' }, { left: '{{login.who}}', op: 'equals', right: '{{user}}' }] }),
      node('orders', 'execute', 'Orders', { requestId: 'r2', outputs: [{ name: 'auth', path: 'headers.authorization' }] }),
      node('alert', 'execute', 'Alert', { requestId: 'r3' }),
      node('done', 'end', 'Done', { outputs: [{ name: 'sent', value: '{{orders.auth}}' }] }),
      node('after', 'end', 'After alert'),
    ],
    edges: [edge('s', 'login'), edge('login', 'ok'), edge('ok', 'orders', 'true'), edge('ok', 'alert', 'false'), edge('orders', 'done'), edge('alert', 'after')],
  };
  const events = [];
  const out = await flow.run({
    flow: f, scopes: { globals: {}, environment: { base: srv.base }, collection: {} }, settings: {}, jar: [],
    requests: {
      login: { request: req('GET', '{{base}}/echo?user={{user}}', { headers: [{ key: 'X-Echo-Token', value: 'tok-1' }] }) },
      orders: { request: req('GET', '{{base}}/echo', { headers: [{ key: 'Authorization', value: 'Bearer {{login.who}}' }]}) },
      alert: { request: req('GET', '{{base}}/status/500') },
    },
    onEvent: (e) => events.push(e.type),
  });
  assert.strictEqual(out.status, 'passed');
  // The echo server returns the request's query and headers in its JSON body.
  assert.deepStrictEqual(out.nodes.login.outputs, { token: undefined, who: 'ada' }, 'headers.* reads response headers; query.user is a body path');
  assert.strictEqual(out.values['login.who'], 'ada');
  assert.strictEqual(out.values['login.status'], '200');
  assert.strictEqual(out.nodes.ok.branch, 'true');
  assert.deepStrictEqual(out.nodes.ok.checks.map((c) => c.passed), [true, true]);
  assert.strictEqual(out.nodes.orders.state, 'done');
  assert.strictEqual(out.nodes.alert.state, 'skipped', 'the false branch is skipped');
  assert.strictEqual(out.nodes.after.state, 'skipped', 'and what only follows from it');
  assert.deepStrictEqual(out.ends, ['done']);
  assert.deepStrictEqual(out.order, ['s', 'login', 'ok', 'orders', 'done']);
  assert.ok(events.includes('node-start') && events[events.length - 1] === 'done');
  assert.strictEqual(JSON.parse(out.nodes.orders.response.bodyText).headers.authorization, 'Bearer ada', 'a value used in a later request');
});

test('a node with several connections in runs once, after all of them; a failed request stops the flow unless told to go on', async () => {
  const calls = [];
  const fakeExecute = async ({ request, scopes }) => {
    calls.push(request.url);
    if (request.url === 'fail') return { error: 'connect ECONNREFUSED', tests: [], scopes };
    return { response: { status: 200, statusText: 'OK', time: 5, headers: {}, bodyText: JSON.stringify({ id: request.url }) }, tests: [], scopes };
  };
  const f = {
    nodes: [node('s', 'start', 'Start'), node('a', 'execute', 'A', { requestId: 'a', outputs: [{ name: 'id', path: 'id' }] }), node('b', 'execute', 'B', { requestId: 'b' }),
      node('join', 'execute', 'Join', { requestId: 'j' }), node('e', 'end', 'End', { outputs: [{ name: 'ids', value: '{{a.id}}' }] })],
    edges: [edge('s', 'a'), edge('s', 'b'), edge('a', 'join'), edge('b', 'join'), edge('join', 'e')],
  };
  const requests = { a: { request: { url: 'A' } }, b: { request: { url: 'B' } }, join: { request: { url: 'J' } } };
  const out = await flow.run({ flow: f, requests, scopes: {}, execute: fakeExecute });
  assert.deepStrictEqual(calls, ['A', 'B', 'J'], 'Join runs once, after A and B');
  assert.deepStrictEqual(out.nodes.e.outputs, { ids: 'A' });

  calls.length = 0;
  requests.a.request.url = 'fail';
  const failed = await flow.run({ flow: f, requests, scopes: {}, execute: fakeExecute });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.nodes.a.state, 'failed');
  assert.strictEqual(failed.nodes.join.state, 'not run', 'the flow stopped');
  f.nodes[1].continueOnError = true;
  const goesOn = await flow.run({ flow: f, requests, scopes: {}, execute: fakeExecute });
  assert.strictEqual(goesOn.nodes.join.state, 'done');
  assert.strictEqual(goesOn.status, 'failed', 'still reported as failed');
});

test('condition operators', async () => {
  const check = async (left, op, right) => {
    const out = await flow.run({ flow: { nodes: [node('s', 'start', 'S', { inputs: [{ key: 'v', value: left }] }), node('c', 'condition', 'C', { rules: [{ left: '{{v}}', op, right }] })], edges: [edge('s', 'c')] }, requests: {}, scopes: {} });
    return out.nodes.c.branch === 'true';
  };
  assert.ok(await check('200', 'equals', '200.0'), 'numbers compare as numbers');
  assert.ok(await check('abc', 'contains', 'b'));
  assert.ok(await check('10', 'greater than', '9'));
  assert.ok(await check('x', 'exists', ''));
  assert.ok(!(await check('', 'exists', '')));
  assert.ok(await check('ORD-42', 'matches', '^ORD-\\d+$'));
  const missing = await flow.run({ flow: { nodes: [node('s', 'start', 'S'), node('c', 'condition', 'C', { rules: [{ left: '{{nope}}', op: 'not exists' }] })], edges: [edge('s', 'c')] }, requests: {}, scopes: {} });
  assert.strictEqual(missing.nodes.c.branch, 'true', 'an unknown {{value}} does not exist');
});

test('a stopped flow reports what did not run', async () => {
  const controller = new AbortController();
  const f = { nodes: [node('s', 'start', 'S'), node('a', 'execute', 'A', { requestId: 'a' }), node('b', 'execute', 'B', { requestId: 'b' })], edges: [edge('s', 'a'), edge('a', 'b')] };
  const out = await flow.run({
    flow: f, scopes: {}, signal: controller.signal, requests: { a: { request: {} }, b: { request: {} } },
    execute: async ({ scopes }) => { controller.abort(); return { response: { status: 200, headers: {}, bodyText: '{}' }, tests: [], scopes }; },
  });
  assert.strictEqual(out.status, 'stopped');
  assert.strictEqual(out.nodes.b.state, 'stopped');
});

test('the End node\'s tabs take the part of a node\'s JSON response at a path, kept as JSON', async () => {
  const body = { data: { items: [{ id: 1, sku: 'A' }, { id: 2, sku: 'B' }], total: 2 } };
  const f = {
    nodes: [node('s', 'start', 'Start', { inputs: [{ key: 'region', value: 'eu' }] }), node('list', 'execute', 'List', { requestId: 'l' }), node('e', 'end', 'End', { tabs: [
      { name: 'Items', node: 'list', path: 'data.items' }, { node: 'list', path: '' }, { name: 'Inputs', node: 's' }, { name: 'Bad', node: 'list', path: 'data.nope' },
    ] })],
    edges: [edge('s', 'list'), edge('list', 'e')],
  };
  const out = await flow.run({ flow: f, scopes: {}, requests: { list: { request: {} } }, execute: async ({ scopes }) => ({ response: { status: 200, headers: {}, bodyText: JSON.stringify(body) }, tests: [], scopes }) });
  const tabs = out.nodes.e.tabs;
  assert.deepStrictEqual(tabs[0], { name: 'Items', node: 'list', path: 'data.items', value: body.data.items });
  assert.strictEqual(tabs[1].name, 'List', 'named after the node when unnamed');
  assert.deepStrictEqual(tabs[1].value, body, 'no path: the whole body');
  assert.deepStrictEqual(tabs[2].value, { region: 'eu' }, 'Start\'s inputs');
  assert.match(tabs[3].missing, /Nothing at "data.nope"/);
});
