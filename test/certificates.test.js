'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execute } = require('../src/core/executor');
const { newRequestDef } = require('../src/core/model');
const { findCertificate, hostMatches } = require('../src/core/certificates');

const dir = path.join(__dirname, 'fixtures', 'certs');
const file = (name) => path.join(dir, name);

// An HTTPS server that only talks to clients presenting a certificate signed by the test CA.
let server;
let base;
test.before(async () => {
  server = https.createServer({
    key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.crt')),
    ca: fs.readFileSync(file('ca.crt')), requestCert: true, rejectUnauthorized: true,
  }, (req, res) => {
    const peer = req.socket.getPeerCertificate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ client: peer && peer.subject ? peer.subject.CN : null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://localhost:${server.address().port}`;
});
test.after(() => server.close());

const send = (settings) => execute({
  request: newRequestDef({ url: `${base}/whoami` }),
  scopes: { globals: {}, collection: {}, environment: {}, data: {} },
  settings: { caCertificate: { enabled: true, path: file('ca.crt') }, ...settings },
});
const cert = (o) => ({ host: 'localhost', enabled: true, ...o });

test('a client certificate (PEM) is sent to a matching host', async () => {
  const res = await send({ certificates: [cert({ crt: file('client.crt'), key: file('client.key') })] });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.response.status, 200);
  assert.deepStrictEqual(JSON.parse(res.response.bodyText), { client: 'httpdash-client' });
  assert.strictEqual(res.response.clientCertificate, 'localhost');
});

test('an encrypted key works with its passphrase and fails clearly without it', async () => {
  const ok = await send({ certificates: [cert({ crt: file('client.crt'), key: file('client-encrypted.key'), passphrase: 'secret' })] });
  assert.strictEqual(ok.response.status, 200);
  const bad = await send({ certificates: [cert({ crt: file('client.crt'), key: file('client-encrypted.key'), passphrase: 'wrong' })] });
  assert.match(bad.error, /passphrase is wrong/);
});

test('a PFX file works with its passphrase', async () => {
  const res = await send({ certificates: [cert({ pfx: file('client.pfx'), passphrase: 'secret' })] });
  assert.strictEqual(res.response.status, 200);
  assert.deepStrictEqual(JSON.parse(res.response.bodyText), { client: 'httpdash-client' });
});

test('without a matching certificate the request fails', async () => {
  const none = await send({ certificates: [] });
  assert.strictEqual(none.error, 'The server requires a client certificate. Add one for this host in Settings → Certificates.');
  const otherPort = await send({ certificates: [cert({ port: 1, crt: file('client.crt'), key: file('client.key') })] });
  assert.ok(otherPort.error, 'a certificate for another port is not used');
  const disabled = await send({ certificates: [cert({ enabled: false, crt: file('client.crt'), key: file('client.key') })] });
  assert.ok(disabled.error, 'a disabled certificate is not used');
});

test('the server is only trusted with the extra CA certificate', async () => {
  const res = await send({ caCertificate: { enabled: false }, certificates: [cert({ crt: file('client.crt'), key: file('client.key') })] });
  assert.match(res.error, /certificate/i);
  const insecure = await send({ caCertificate: null, verifySSL: false, certificates: [cert({ crt: file('client.crt'), key: file('client.key') })] });
  assert.strictEqual(insecure.response.status, 200);
});

test('a missing certificate file is reported with its path', async () => {
  const res = await send({ certificates: [cert({ crt: file('nope.crt'), key: file('client.key') })] });
  assert.match(res.error, /Could not read the certificate file at .*nope\.crt/);
});

test('certificates match by host, wildcard and port', () => {
  assert.ok(hostMatches('api.example.com', 'api.example.com'));
  assert.ok(hostMatches('https://API.example.com/', 'api.example.com'));
  assert.ok(hostMatches('*.example.com', 'a.b.example.com'));
  assert.ok(!hostMatches('*.example.com', 'example.com'));
  assert.ok(!hostMatches('example.com', 'badexample.com'));
  const list = [{ host: 'api.test', port: 8443, crt: 'a' }, { host: '*.test', crt: 'b' }];
  assert.strictEqual(findCertificate(list, 'https://api.test:8443/x').crt, 'a');
  assert.strictEqual(findCertificate(list, 'https://api.test/x').crt, 'b');
  assert.strictEqual(findCertificate(list, 'http://api.test/x'), null); // plain HTTP never sends one
});

test('exports without secrets leave out certificate passphrases', () => {
  const { stripSecrets } = require('../src/core/backup');
  const ws = { collections: [], environments: [], settings: { certificates: [{ host: 'a.test', pfx: '/x.pfx', passphrase: 'secret' }] } };
  stripSecrets(ws);
  assert.strictEqual(ws.settings.certificates[0].passphrase, '');
  assert.strictEqual(ws.settings.certificates[0].pfx, '/x.pfx');
});

test('the CLI sends client certificates with Newman-compatible flags', async () => {
  const os = require('os');
  const { main: cli } = require('../bin/httpdash');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-certs-'));
  const collection = path.join(tmp, 'c.json');
  fs.writeFileSync(collection, JSON.stringify({
    info: { name: 'mTLS', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'whoami', request: { method: 'GET', url: `${base}/whoami` }, event: [{ listen: 'test', script: { exec: ["pm.test('client cert', () => pm.expect(pm.response.json().client).to.equal('httpdash-client'));"] } }] }],
  }));
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s) };
  const single = await cli(['run', collection, '--no-color', '--ssl-client-cert', file('client.crt'), '--ssl-client-key', file('client.key'), '--ssl-extra-ca-certs', file('ca.crt')], io);
  assert.strictEqual(single, 0, lines.join('\n'));

  const list = path.join(tmp, 'certs.json');
  fs.writeFileSync(list, JSON.stringify([{ name: 'local', matches: [`https://localhost:${server.address().port}/*`], pfx: { src: path.relative(tmp, file('client.pfx')) }, passphrase: 'secret' }]));
  const fromList = await cli(['run', collection, '--no-color', '--ssl-client-cert-list', list, '--ssl-extra-ca-certs', file('ca.crt')], io);
  assert.strictEqual(fromList, 0, lines.join('\n'));

  const without = await cli(['run', collection, '--no-color', '--ssl-extra-ca-certs', file('ca.crt')], io);
  assert.strictEqual(without, 1);
  assert.match(lines.join('\n'), /requires a client certificate/);
});

test('certificates installed on the computer are trusted unless turned off', async (t) => {
  const certificates = require('../src/core/certificates');
  certificates.setSystemProvider(() => [fs.readFileSync(file('ca.crt'), 'utf8')]); // as if IT installed the test CA
  t.after(() => certificates.setSystemProvider(() => []));
  const viaSystem = await send({ caCertificate: null, certificates: [cert({ crt: file('client.crt'), key: file('client.key') })] });
  assert.strictEqual(viaSystem.response && viaSystem.response.status, 200, viaSystem.error);
  const off = await send({ caCertificate: null, useSystemCertificates: false, certificates: [cert({ crt: file('client.crt'), key: file('client.key') })] });
  assert.match(off.error, /certificate/i);
});

test('TLS contexts are built once and reused', () => {
  const { tlsFor } = require('../src/core/certificates');
  const settings = { certificates: [cert({ crt: file('client.crt'), key: file('client.key') })], caCertificate: { path: file('ca.crt') } };
  const a = tlsFor('https://localhost/a', settings);
  const b = tlsFor('https://localhost/b', settings);
  assert.strictEqual(a.secureContext, b.secureContext);
  assert.strictEqual(tlsFor('http://localhost/a', settings), null);
});
