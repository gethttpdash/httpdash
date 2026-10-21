'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { instancesFor } = require('../src/core/dns-instances');
const { send } = require('../src/core/http-client');

const fake = (table) => async (host) => {
  if (!table[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const lookup = fake({
  'orders.internal': ['10.0.1.5', '10.0.1.6', '10.0.1.7', '10.0.1.6'],
  'api.example.com': ['93.184.216.34', '2606:2800:220:1::248'],
  'v6.example.com': ['2001:db8::1', '2001:db8::2', '93.184.216.34'],
  localhost: ['127.0.0.1', '::1'],
});

test('a host with several addresses of one family has instances', async () => {
  assert.deepStrictEqual(await instancesFor('https://orders.internal/orders?x=1', { lookup, fresh: true }),
    { host: 'orders.internal', protocol: 'https:', port: '443', family: 4, addresses: ['10.0.1.5', '10.0.1.6', '10.0.1.7'] });
  const v6 = await instancesFor('http://v6.example.com:8080/', { lookup, fresh: true });
  assert.deepStrictEqual([v6.family, v6.port, v6.addresses], [6, '8080', ['2001:db8::1', '2001:db8::2']]);
});

test('one server reached two ways, loopback, addresses and unknown hosts have none', async () => {
  assert.strictEqual(await instancesFor('https://api.example.com/', { lookup, fresh: true }), null);
  assert.strictEqual(await instancesFor('http://localhost:3000/', { lookup, fresh: true }), null);
  assert.strictEqual(await instancesFor('http://10.0.1.5/', { lookup, fresh: true }), null);
  assert.strictEqual(await instancesFor('http://nope.invalid/', { lookup, fresh: true }), null);
  assert.strictEqual(await instancesFor('not a url', { lookup }), null);
});

test('answers are cached unless asked fresh', async () => {
  let calls = 0;
  const counting = async (h) => { calls++; return [{ address: '10.9.0.1', family: 4 }, { address: `10.9.0.${calls + 1}`, family: 4 }]; };
  await instancesFor('http://cached.internal/', { lookup: counting, fresh: true });
  const again = await instancesFor('http://cached.internal/', { lookup: counting });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(again.addresses, ['10.9.0.1', '10.9.0.2']);
  await instancesFor('http://cached.internal/', { lookup: counting, fresh: true });
  assert.strictEqual(calls, 2);
});

test('a request can be sent to one chosen address, keeping its host name', async () => {
  const server = http.createServer((req, res) => { res.end(JSON.stringify({ host: req.headers.host, conn: req.socket.remotePort })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const url = `http://orders.internal:${port}/orders`;
    const pinned = { host: 'orders.internal', address: '127.0.0.1', family: 4 };
    const a = await send({ method: 'GET', url, headers: [], connectTo: pinned });
    const b = await send({ method: 'GET', url, headers: [], connectTo: pinned });
    const ja = JSON.parse(a.body.toString());
    const jb = JSON.parse(b.body.toString());
    assert.strictEqual(ja.host, `orders.internal:${port}`, 'the Host header is the name, not the address');
    assert.notStrictEqual(ja.conn, jb.conn, 'pinned requests never share a pooled connection');
    await assert.rejects(send({ method: 'GET', url, headers: [], connectTo: pinned, proxy: { enabled: true, host: '127.0.0.1', port: 9 } }), /proxy picks the address/);
  } finally { server.close(); }
});
