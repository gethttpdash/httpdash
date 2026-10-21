'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSend, parseSendArgs, sendBody } = require('../src/core/send-command');

const io = () => { const o = { out: [], err: [], body: '' }; return { o, io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s), write: (s) => { o.body += s; } } }; };

test('arguments read like curl: method, URL, headers and bodies', () => {
  assert.deepStrictEqual(parseSendArgs(['https://api/x']).url, 'https://api/x');
  assert.strictEqual(parseSendArgs(['delete', 'https://api/x']).method, 'DELETE');
  assert.strictEqual(parseSendArgs(['-X', 'patch', 'https://api/x']).method, 'PATCH');
  assert.throws(() => parseSendArgs([]), /URL/);
  assert.throws(() => parseSendArgs(['--bogus', 'u']), /Unknown option/);
  assert.throws(() => parseSendArgs(['-d', 'a', '--json', 'b', 'u']), /not both/);
  const b = sendBody(parseSendArgs(['https://api/orders', '-H', 'X-Trace: 1', '-d', '{"qty":3}']));
  assert.strictEqual(b.request.method, 'POST', 'a body makes it a POST, as in curl');
  assert.deepStrictEqual(b.request.headers, [{ key: 'X-Trace', value: '1' }, { key: 'Content-Type', value: 'application/json' }]);
  assert.strictEqual(b.request.body.rawLanguage, 'json');
  const form = sendBody(parseSendArgs(['-d', 'a=1&b=2', 'https://api/form']));
  assert.strictEqual(form.request.headers[0].value, 'application/x-www-form-urlencoded');
  const j = sendBody(parseSendArgs(['--json', '[1]', 'https://api/x']));
  assert.deepStrictEqual(j.request.headers.map((h) => h.key), ['Content-Type', 'Accept']);
  assert.throws(() => sendBody(parseSendArgs(['-H', 'nocolon', 'u'])), /Name: value/);
});

test('a body can come from a file, and saving options pass through', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-send-')), 'b.json');
  fs.writeFileSync(file, '{"a":1}');
  const b = sendBody(parseSendArgs(['--json', `@${file}`, 'https://api/x', '-c', 'Orders API', '--folder', 'Orders/Admin', '--save-always', '--name', 'Make order', '-t', 'smoke']), 'env-1');
  assert.strictEqual(b.request.body.raw, '{"a":1}');
  assert.deepStrictEqual({ c: b.collection, f: b.folder, s: b.save, i: b.saveIf, n: b.name, t: b.tags, e: b.environmentId }, { c: 'Orders API', f: 'Orders/Admin', s: true, i: 'always', n: 'Make order', t: ['smoke'], e: 'env-1' });
});

test('the answer is printed like curl, with what was saved on stderr', async () => {
  const calls = [];
  const call = async (method, p, body) => {
    calls.push([method, p, body]);
    if (p === '/environments') return { status: 200, json: { items: [{ id: 'e1', name: 'Staging' }] } };
    return { status: 200, json: { response: { status: 201, statusText: 'Created', headers: [['Content-Type', 'application/json']], body: '{"ok":true}', time: 12, size: 40 }, saved: { kept: true, path: 'Orders API / Orders', name: 'POST /orders', created: true } } };
  };
  const { o, io: out } = io();
  const code = await runSend(['POST', '{{orders_url}}/orders', '-e', 'staging', '-c', 'Orders API', '--folder', 'Orders', '--save', '-i'], out, { call });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[1][2].environmentId, 'e1', 'the environment is found by name');
  assert.deepStrictEqual(o.out.slice(0, 2), ['HTTP 201 Created', 'Content-Type: application/json']);
  assert.strictEqual(o.body, '{"ok":true}\n');
  assert.match(o.err.join('\n'), /Saved in Orders API \/ Orders as "POST \/orders" \(new\)/);
});

test('exit codes: 22 with -f on an error status, 1 when the request fails, 3 when HttpDash refuses or is away', async () => {
  const answer = (json) => async () => ({ status: 200, json });
  let r = io();
  assert.strictEqual(await runSend(['-f', 'https://api/x'], r.io, { call: answer({ response: { status: 404, statusText: 'Not Found', headers: [], body: '' } }) }), 22);
  r = io();
  assert.strictEqual(await runSend(['https://api/x'], r.io, { call: answer({ error: 'Could not resolve host' }) }), 1);
  assert.match(r.o.err.join('\n'), /Could not resolve host/);
  r = io();
  assert.strictEqual(await runSend(['https://api/x', '--save', '-c', 'A'], r.io, { call: async () => ({ status: 403, json: { error: 'Saving needs the "edit" permission' } }) }), 3);
  r = io();
  assert.strictEqual(await runSend(['https://api/x'], r.io, { call: async () => { throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }); } }), 3);
  assert.match(r.o.err.join('\n'), /not running, or AI access is off/);
});
