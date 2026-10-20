'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { send } = require('../src/core/http-client');

// Answers with the id of the connection the request came in on.
function server(handler) {
  let next = 0;
  const s = http.createServer((req, res) => {
    if (!req.socket.connId) req.socket.connId = ++next;
    if (handler && handler(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(req.socket.connId));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const get = (url, extra = {}) => send({ method: 'GET', url, headers: [], body: null, timeout: 5000, ...extra });

test('connections are reused, and the timings say so', async () => {
  const s = await server();
  try {
    const url = `http://127.0.0.1:${s.address().port}/`;
    const a = await get(url);
    const b = await get(url);
    assert.strictEqual(a.body.toString(), b.body.toString(), 'the same connection');
    assert.ok(a.timings.connect != null && !a.timings.reused);
    assert.strictEqual(b.timings.reused, true);
    assert.strictEqual(b.timings.connect, undefined);
    // Turned off: a new connection every time.
    const c = await get(url, { reuseConnections: false });
    const d = await get(url, { reuseConnections: false });
    assert.notStrictEqual(c.body.toString(), d.body.toString());
  } finally { s.close(); s.closeAllConnections(); }
});

test('a connection the server dropped is retried once on a new one', async () => {
  // The second request on any connection is dropped without an answer, as a server closing an idle
  // keep-alive connection would.
  const s = await server((req) => {
    req.socket.requests = (req.socket.requests || 0) + 1;
    if (req.socket.requests === 2) { req.socket.destroy(); return true; }
    return false;
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/`;
    const first = await get(url);
    const second = await get(url, { method: 'POST', body: Buffer.from('{}') });
    assert.strictEqual(second.status, 200);
    assert.notStrictEqual(second.body.toString(), first.body.toString(), 'answered on a new connection');
  } finally { s.close(); s.closeAllConnections(); }
});

test('a request the server fails on a new connection is not retried', async () => {
  let calls = 0;
  const s = await server((req) => { calls++; req.socket.destroy(); return true; });
  try {
    await assert.rejects(get(`http://127.0.0.1:${s.address().port}/`, { reuseConnections: false }));
    assert.strictEqual(calls, 1);
  } finally { s.close(); }
});
