'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { AiServer } = require('../src/core/ai-server');
const { OPERATIONS } = require('../src/core/ai-api-spec');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ai-'));
const calls = [];
let locked = false;
const server = new AiServer({
  file: path.join(dir, 'ai-access.json'), version: '9.9.9', isLocked: () => locked,
  call: async (op, args, ctx) => { calls.push({ op, args, ctx }); if (op === 'getRequest' && args.requestId === 'missing') throw Object.assign(new Error('No request'), { status: 404 }); return { op, args }; },
  main: { getAccessLog: ({ limit }) => ({ items: server.log(limit) }), takeScreenshot: async () => ({ png: Buffer.from('PNGDATA'), width: 10, height: 5 }) },
});
let port;
const call = (method, p, { token = server.token(), body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode, type: res.headers['content-type'], raw: b, json: /json/.test(res.headers['content-type'] || '') ? JSON.parse(b.toString()) : null }); });
  });
  req.on('error', reject);
  req.end(data);
});

test.before(async () => {
  await server.configure({ enabled: true, port: 0 + 47900 + Math.floor(Math.random() * 500), permissions: { read: true, run: false, edit: true, ui: true } });
  port = server.config.port;
  assert.ok(server.status().listening, server.status().error || 'listening');
});
test.after(() => server.stop());

test('the OpenAPI document needs no token and lists every operation with its permission', async () => {
  const r = await call('GET', '/openapi.json', { token: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.openapi, '3.1.0');
  assert.strictEqual(r.json.info.version, '9.9.9');
  assert.strictEqual(r.json.servers[0].url, `http://127.0.0.1:${port}`);
  const ops = Object.values(r.json.paths).flatMap((p) => Object.values(p));
  assert.strictEqual(ops.length, OPERATIONS.length);
  assert.ok(ops.every((o) => o.operationId && o.summary && ['read', 'run', 'edit', 'ui'].includes(o['x-permission'])));
});

test('no token, a wrong token, a browser or a foreign host are refused', async () => {
  assert.strictEqual((await call('GET', '/status', { token: null })).status, 401);
  assert.strictEqual((await call('GET', '/status', { token: 'x'.repeat(43) })).status, 401);
  assert.strictEqual((await call('GET', '/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await call('GET', '/status', { headers: { Host: 'evil.example' } })).status, 403);
  assert.strictEqual(calls.length, 0, 'none of them reached the app');
});

test('operations get their path, query and body; permissions, lock and pause are enforced', async () => {
  const ok = await call('PATCH', '/requests/r-1', { body: { name: 'New name' } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { op: 'updateRequest', args: { requestId: 'r-1', body: { name: 'New name' } } });
  const search = await call('GET', '/requests?tag=smoke&limit=5');
  assert.deepStrictEqual(search.json.args, { tag: 'smoke', limit: 5, body: {} });
  const denied = await call('POST', '/requests/r-1/send', { body: {} });
  assert.strictEqual(denied.status, 403);
  assert.match(denied.json.error, /"run" permission/);
  assert.strictEqual((await call('GET', '/requests/missing')).status, 404);
  assert.strictEqual((await call('GET', '/nope')).status, 404);
  assert.strictEqual((await call('PATCH', '/requests/r-1', { body: [1] })).status, 400);
  locked = true;
  assert.strictEqual((await call('GET', '/status')).status, 423);
  locked = false;
  await server.configure({ ...server.config, paused: true });
  assert.strictEqual((await call('GET', '/status')).status, 503);
  await server.configure({ ...server.config, paused: false });
});

test('screenshots come back as PNG or base64; every call is in the access log', async () => {
  const png = await call('GET', '/ui/screenshot');
  assert.strictEqual(png.type, 'image/png');
  assert.strictEqual(png.raw.toString(), 'PNGDATA');
  const b64 = await call('GET', '/ui/screenshot?format=base64');
  assert.deepStrictEqual(b64.json, { base64: Buffer.from('PNGDATA').toString('base64'), width: 10, height: 5 });
  const log = (await call('GET', '/access-log?limit=50')).json.items;
  assert.ok(log.some((e) => e.op === 'updateRequest' && e.status === 200 && e.permission === 'edit'));
  assert.ok(log.some((e) => e.op === 'sendRequest' && e.status === 403));
  assert.ok(log.some((e) => e.op === 'takeScreenshot' && e.summary === 'screenshot 10×5'));
});

test('a new token locks out the old one; the token file is for the user only', async () => {
  const old = server.token();
  const fresh = server.regenerateToken();
  assert.notStrictEqual(fresh, old);
  assert.strictEqual((await call('GET', '/status', { token: old })).status, 401);
  assert.strictEqual((await call('GET', '/status', { token: fresh })).status, 200);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'ai-access.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(file).sort(), ['port', 'token', 'url']);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'ai-access.json')).mode & 0o777, 0o600);
});
