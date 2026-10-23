'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const grpcJs = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { ReflectionService } = require('@grpc/reflection');
const grpc = require('../src/core/grpc');
const { tlsFor } = require('../src/core/certificates');

const FIXTURES = path.join(__dirname, 'fixtures', 'grpc');
const PROTO = path.join(FIXTURES, 'orders.proto');
const INCLUDE = path.join(FIXTURES, 'include');
const CERTS = path.join(__dirname, 'fixtures', 'certs');

// A reference server (grpc-js with proto-loader), optionally with reflection and TLS.
async function startServer({ reflection = false, tls = false } = {}) {
  const def = protoLoader.loadSync(PROTO, { includeDirs: [INCLUDE], keepCase: true, longs: String, enums: String, defaults: true });
  const pkg = grpcJs.loadPackageDefinition(def);
  const server = new grpcJs.Server();
  server.addService(pkg.shop.v1.Orders.service, {
    GetOrder(call, callback) {
      if (call.request.order_id === 'missing') return callback({ code: grpcJs.status.NOT_FOUND, details: 'No order missing' });
      const headers = new grpcJs.Metadata();
      headers.set('x-served-by', 'test');
      call.sendMetadata(headers);
      const trailers = new grpcJs.Metadata();
      trailers.set('x-trailer', 'done');
      callback(null, {
        order_id: call.request.order_id, items: [{ sku: 'A-1', qty: 2 }], status: 'SHIPPED', total_cents: '9007199254740993',
        labels: { auth: call.metadata.get('authorization')[0] || '', tenant: call.metadata.get('x-tenant')[0] || '' }, card: '4242',
      }, trailers);
    },
    ListOrders(call) {
      let i = 0;
      const next = () => {
        if (call.cancelled) return;
        if (i >= call.request.limit) return call.end();
        i++;
        call.write({ order_id: `o-${i}`, status: call.request.status });
        setTimeout(next, call.request.delay_ms || 0);
      };
      next();
    },
    AddItems(call, callback) {
      const items = [];
      call.on('data', (item) => items.push(item));
      call.on('end', () => callback(null, { order_id: 'new', items }));
    },
    Chat(call) {
      call.on('data', (m) => call.write({ text: `echo: ${m.text}` }));
      call.on('end', () => call.end());
    },
  });
  if (reflection) new ReflectionService(def).addToServer(server);
  const creds = tls
    ? grpcJs.ServerCredentials.createSsl(null, [{ cert_chain: fs.readFileSync(path.join(CERTS, 'server.crt')), private_key: fs.readFileSync(path.join(CERTS, 'server.key')) }])
    : grpcJs.ServerCredentials.createInsecure();
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', creds, (e, p) => (e ? reject(e) : resolve(p))));
  return { server, port, stop: () => server.forceShutdown() };
}

test('addresses: host:port, and URLs whose scheme says whether TLS is on', () => {
  assert.deepStrictEqual(grpc.parseTarget('localhost:50051'), { host: 'localhost', port: '50051', secure: false, address: 'localhost:50051' });
  assert.deepStrictEqual(grpc.parseTarget('grpcs://api.example.com'), { host: 'api.example.com', port: '443', secure: true, address: 'api.example.com:443' });
  assert.deepStrictEqual(grpc.parseTarget('https://api.example.com:8443/ignored'), { host: 'api.example.com', port: '8443', secure: true, address: 'api.example.com:8443' });
  assert.strictEqual(grpc.parseTarget('grpc://10.0.0.5:9090').secure, false);
  assert.strictEqual(grpc.parseTarget('localhost:50051', 'on').secure, true);
  assert.strictEqual(grpc.parseTarget('grpcs://h:1', 'off').secure, false);
  assert.strictEqual(grpc.parseTarget('[::1]:50051').address, '[::1]:50051');
  assert.throws(() => grpc.parseTarget('localhost'), /Add the port/);
  assert.throws(() => grpc.parseTarget('ftp://h:1'), /grpc:\/\//);
  assert.throws(() => grpc.parseTarget(''), /server address/);
});

test('.proto files with imports describe each method and an example message', () => {
  const root = grpc.loadProtoFiles([PROTO], [INCLUDE]);
  const [svc] = grpc.describe(root);
  assert.strictEqual(svc.name, 'shop.v1.Orders');
  assert.deepStrictEqual(svc.methods.map((m) => [m.name, m.kind]), [['GetOrder', 'unary'], ['ListOrders', 'server-stream'], ['AddItems', 'client-stream'], ['Chat', 'bidi']]);
  assert.strictEqual(svc.methods[0].path, '/shop.v1.Orders/GetOrder');
  assert.deepStrictEqual(svc.methods[1].example, { limit: 0, status: 'STATUS_UNSPECIFIED', delay_ms: 0 });
  const order = grpc.example(root.lookupType('shop.v1.Order'));
  assert.deepStrictEqual(order, {
    order_id: '', items: [{ sku: '', qty: 0 }], status: 'STATUS_UNSPECIFIED', total_cents: '0', labels: { key: '' },
    created_at: { seconds: '0', nanos: 0 }, card: '',
  }, 'nested and repeated messages, enums, 64-bit numbers as strings, maps, one field per oneof');
  assert.throws(() => grpc.loadProtoFiles([PROTO]), /Could not read the \.proto files/, 'without the import path, the import is missing');
  assert.throws(() => grpc.loadProtoFiles([]), /Add a \.proto file/);
});

test('calls of every kind, with metadata, headers and trailers', async () => {
  const s = await startServer();
  const root = grpc.loadProtoFiles([PROTO], [INCLUDE]);
  const base = { target: `127.0.0.1:${s.port}`, root, service: 'shop.v1.Orders' };
  try {
    const unary = await grpc.invoke({ ...base, method: 'GetOrder', message: { orderId: 'o-7' }, metadata: [['Authorization', 'Bearer t0k'], ['x-tenant', 'acme']] });
    assert.deepStrictEqual(unary.status, { code: 0, name: 'OK', details: 'OK' });
    assert.strictEqual(unary.messages.length, 1);
    const o = unary.messages[0];
    assert.strictEqual(o.order_id, 'o-7', 'lowerCamelCase field names are accepted');
    assert.strictEqual(o.total_cents, '9007199254740993', '64-bit numbers keep every digit');
    assert.strictEqual(o.status, 'SHIPPED');
    assert.deepStrictEqual(o.labels, { auth: 'Bearer t0k', tenant: 'acme' });
    assert.strictEqual(o.card, '4242');
    assert.ok(unary.headers.some(([k, v]) => k === 'x-served-by' && v === 'test'));
    assert.ok(unary.trailers.some(([k, v]) => k === 'x-trailer' && v === 'done'));

    const listed = await grpc.invoke({ ...base, method: 'ListOrders', message: { limit: 3, status: 'OPEN' } });
    assert.deepStrictEqual(listed.messages.map((m) => [m.order_id, m.status]), [['o-1', 'OPEN'], ['o-2', 'OPEN'], ['o-3', 'OPEN']]);

    const added = await grpc.invoke({ ...base, method: 'AddItems', messages: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }] });
    assert.deepStrictEqual(added.messages[0].items, [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);

    // Bidirectional, one message at a time while the call is open.
    const call = grpc.start({ ...base, method: 'Chat' });
    const got = [];
    const ended = new Promise((resolve) => call.on('status', resolve));
    call.on('message', (m) => { got.push(m.text); if (got.length === 1) call.write({ text: 'second' }); else call.end(); });
    call.write({ text: 'first' });
    assert.strictEqual((await ended).name, 'OK');
    assert.deepStrictEqual(got, ['echo: first', 'echo: second']);
  } finally { s.stop(); }
});

test('errors: a status from the server, an unknown field, a deadline and no server', async () => {
  const s = await startServer();
  const root = grpc.loadProtoFiles([PROTO], [INCLUDE]);
  const base = { target: `127.0.0.1:${s.port}`, root, service: 'shop.v1.Orders' };
  try {
    const missing = await grpc.invoke({ ...base, method: 'GetOrder', message: { order_id: 'missing' } });
    assert.deepStrictEqual(missing.status, { code: 5, name: 'NOT_FOUND', details: 'No order missing' });
    assert.strictEqual(missing.messages.length, 0);

    await assert.rejects(grpc.invoke({ ...base, method: 'GetOrder', message: { orderid: 'x' } }), /shop\.v1\.GetOrderRequest has no field "orderid"/);
    await assert.rejects(grpc.invoke({ ...base, method: 'AddItems', messages: [{ sku: 'A', colour: 'red' }] }), /has no field "colour"/);
    await assert.rejects(grpc.invoke({ ...base, method: 'Nope' }), /has no method "Nope"/);
    await assert.rejects(grpc.invoke({ ...base, service: 'shop.v1.Missing', method: 'GetOrder' }), /no service "shop\.v1\.Missing"/);

    const slow = await grpc.invoke({ ...base, method: 'ListOrders', message: { limit: 5, delay_ms: 100 }, deadlineMs: 150 });
    assert.strictEqual(slow.status.name, 'DEADLINE_EXCEEDED');
    assert.ok(slow.messages.length >= 1 && slow.messages.length < 5, 'messages that arrived in time are kept');
  } finally { s.stop(); }
  const down = await grpc.invoke({ target: `127.0.0.1:${s.port}`, root, service: 'shop.v1.Orders', method: 'GetOrder', message: {}, deadlineMs: 2000 });
  assert.strictEqual(down.status.name, 'UNAVAILABLE');
});

test('server reflection lists the services and their definitions, imports included', async () => {
  const s = await startServer({ reflection: true });
  try {
    const root = await grpc.reflect({ target: `grpc://127.0.0.1:${s.port}` });
    const services = grpc.describe(root);
    assert.deepStrictEqual(services.map((x) => x.name), ['shop.v1.Orders'], "reflection's own service is left out");
    assert.deepStrictEqual(services[0].methods.map((m) => m.kind), ['unary', 'server-stream', 'client-stream', 'bidi']);
    const res = await grpc.invoke({ target: `127.0.0.1:${s.port}`, root, service: 'shop.v1.Orders', method: 'GetOrder', message: { order_id: 'r-1' } });
    assert.strictEqual(res.messages[0].order_id, 'r-1');
    assert.strictEqual(res.messages[0].items[0].sku, 'A-1', 'types from the imported file work');
    assert.deepStrictEqual(res.messages[0].labels, { auth: '', tenant: '' }, 'map fields are objects, not lists of entries');
    assert.deepStrictEqual(grpc.example(root.lookupType('shop.v1.Order')).labels, { key: '' });
  } finally { s.stop(); }
  const plain = await startServer();
  try {
    await assert.rejects(grpc.reflect({ target: `127.0.0.1:${plain.port}` }), /does not offer reflection/);
  } finally { plain.stop(); }
});

test('TLS uses the trusted CAs from settings, and verification can be turned off', async () => {
  const s = await startServer({ tls: true, reflection: true });
  const root = grpc.loadProtoFiles([PROTO], [INCLUDE]);
  const call = (extra) => grpc.invoke({ target: `grpcs://localhost:${s.port}`, root, service: 'shop.v1.Orders', method: 'GetOrder', message: { order_id: 't' }, deadlineMs: 3000, ...extra });
  try {
    const untrusted = await call({ tlsFor: (u) => tlsFor(u, { useSystemCertificates: false }) });
    assert.strictEqual(untrusted.status.name, 'UNAVAILABLE', 'a certificate from an unknown CA is refused');
    const settings = { useSystemCertificates: false, caCertificate: { enabled: true, path: path.join(CERTS, 'ca.crt') } };
    const trusted = await call({ tlsFor: (u) => tlsFor(u, settings) });
    assert.strictEqual(trusted.status.name, 'OK');
    const unverified = await call({ verifySSL: false });
    assert.strictEqual(unverified.status.name, 'OK');
    const reflected = await grpc.reflect({ target: `localhost:${s.port}`, tls: 'on', tlsFor: (u) => tlsFor(u, settings) });
    assert.strictEqual(grpc.describe(reflected)[0].name, 'shop.v1.Orders');
  } finally { s.stop(); }
});
