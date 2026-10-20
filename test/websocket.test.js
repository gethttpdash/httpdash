'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const { connect } = require('../src/core/websocket');
const { tlsFor } = require('../src/core/certificates');

// A reference server (the "ws" package) that echoes, and reacts to a few commands.
function startServer(serverOpts = {}, httpServer = http.createServer()) {
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false, ...serverOpts });
  wss.on('connection', (socket, req) => {
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === 'headers') socket.send(JSON.stringify({ auth: req.headers.authorization, protocol: socket.protocol }));
      else if (text === 'fragmented') { socket.send('hello ', { fin: false }); socket.send('wor', { fin: false }); socket.send('ld', { fin: true }); }
      else if (text === 'ping') socket.ping('are you there');
      else if (text === 'bye') socket.close(4001, 'see you');
      else if (text === 'bad-utf8') socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
      else if (text === 'big') socket.send('x'.repeat(2048));
      else socket.send(data, { binary: isBinary });
    });
  });
  return new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve({ wss, httpServer, port: httpServer.address().port })));
}

const next = (conn, event) => new Promise((resolve) => conn.once(event, resolve));

test('text and binary messages round-trip, and the handshake is reported', async () => {
  const s = await startServer();
  try {
    const conn = await connect({ url: `ws://127.0.0.1:${s.port}/chat?room=1` });
    assert.strictEqual(conn.handshake.status, 101);
    assert.ok(conn.handshake.headers.some(([k]) => k.toLowerCase() === 'sec-websocket-accept'));
    conn.send('héllo ✓');
    assert.deepStrictEqual(await next(conn, 'message'), { data: 'héllo ✓', binary: false, size: Buffer.byteLength('héllo ✓') });
    conn.send(Buffer.from([1, 2, 3]));
    const bin = await next(conn, 'message');
    assert.strictEqual(bin.binary, true);
    assert.deepStrictEqual([...bin.data], [1, 2, 3]);
    const big = 'y'.repeat(1024 * 1024); // takes the 64-bit length path
    conn.send(big);
    assert.strictEqual((await next(conn, 'message')).data.length, big.length);
    conn.close(1000, 'done');
    const closed = await next(conn, 'close');
    assert.strictEqual(closed.code, 1000);
  } finally { s.wss.close(); s.httpServer.close(); }
});

test('fragmented messages, pings and server closes are handled', async () => {
  const s = await startServer();
  try {
    const conn = await connect({ url: `ws://127.0.0.1:${s.port}` });
    conn.send('fragmented');
    assert.strictEqual((await next(conn, 'message')).data, 'hello world');
    const pong = new Promise((resolve) => s.wss.clients.forEach((c) => c.once('pong', (d) => resolve(d.toString()))));
    conn.send('ping');
    assert.strictEqual(await pong, 'are you there'); // answered automatically
    conn.send('bye');
    assert.deepStrictEqual(await next(conn, 'close'), { code: 4001, reason: 'see you', label: '' });
  } finally { s.wss.close(); s.httpServer.close(); }
});

test('headers, auth and subprotocols go into the handshake', async () => {
  const s = await startServer({ handleProtocols: (protocols) => (protocols.has('graphql-ws') ? 'graphql-ws' : false) });
  try {
    const conn = await connect({ url: `ws://127.0.0.1:${s.port}`, headers: [['Authorization', 'Bearer abc'], ['Upgrade', 'ignored']], protocols: ['graphql-ws', 'v2'] });
    assert.strictEqual(conn.handshake.protocol, 'graphql-ws');
    conn.send('headers');
    assert.deepStrictEqual(JSON.parse((await next(conn, 'message')).data), { auth: 'Bearer abc', protocol: 'graphql-ws' });
    conn.close();
  } finally { s.wss.close(); s.httpServer.close(); }
});

test('a refused upgrade reports the status and body', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"token required"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(connect({ url: `ws://127.0.0.1:${server.address().port}` }), (e) => {
      assert.strictEqual(e.code, 'EWSREFUSED');
      assert.strictEqual(e.status, 401);
      assert.strictEqual(e.body, '{"error":"token required"}');
      return true;
    });
    await assert.rejects(connect({ url: 'http://example.com' }), /start with ws:\/\/ or wss:\/\//);
  } finally { server.close(); }
});

test('invalid UTF-8 and oversized messages close the connection', async () => {
  const s = await startServer();
  try {
    const a = await connect({ url: `ws://127.0.0.1:${s.port}` });
    a.on('error', () => {});
    a.send('bad-utf8');
    assert.strictEqual((await next(a, 'close')).code, 1007);
    const b = await connect({ url: `ws://127.0.0.1:${s.port}`, maxMessageBytes: 1024 });
    b.on('error', () => {});
    b.send('big');
    assert.strictEqual((await next(b, 'close')).code, 1009);
  } finally { s.wss.close(); s.httpServer.close(); }
});

test('wss:// uses client certificates and trusted CAs', async () => {
  const f = (n) => path.join(__dirname, 'fixtures', 'certs', n);
  const httpsServer = https.createServer({ key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), ca: fs.readFileSync(f('ca.crt')), requestCert: true, rejectUnauthorized: true });
  const s = await startServer({}, httpsServer);
  try {
    const settings = { caCertificate: { path: f('ca.crt') }, certificates: [{ host: 'localhost', crt: f('client.crt'), key: f('client.key') }] };
    const conn = await connect({ url: `wss://localhost:${s.port}`, tlsFor: (u) => tlsFor(u, settings) });
    conn.send('secure');
    assert.strictEqual((await next(conn, 'message')).data, 'secure');
    conn.close();
    await assert.rejects(connect({ url: `wss://localhost:${s.port}`, tlsFor: (u) => tlsFor(u, { caCertificate: settings.caCertificate }) }));
  } finally { s.wss.close(); s.httpServer.close(); }
});

test('a message sent right after the handshake is not lost', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('connection', (s) => s.send('welcome'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (let i = 0; i < 20; i++) {
      const conn = await connect({ url: `ws://127.0.0.1:${server.address().port}` });
      // Listening only after connect() resolves, as the app does.
      assert.strictEqual((await next(conn, 'message')).data, 'welcome');
      conn.close();
    }
  } finally { wss.close(); server.close(); }
});
