'use strict';

const test = require('node:test');
const assert = require('node:assert');
const network = require('../src/core/network');
const balancer = require('../src/core/balancer');
const { execute } = require('../src/core/executor');
const { startServer } = require('./helpers');

test('an address is split into octets, with its segment and kind', () => {
  const a = network.describe('10.42.7.31', { own: [] });
  assert.deepStrictEqual(a.octets, [10, 42, 7, 31]);
  assert.strictEqual(a.segment, '10.42.7.0/24');
  assert.strictEqual(a.kind, 'private');
  assert.strictEqual(network.describe('10.42.7.31', { bits4: 16, own: [] }).segment, '10.42.0.0/16');
  assert.strictEqual(network.describe('172.20.1.1', { own: [] }).kind, 'private');
  assert.strictEqual(network.describe('172.32.1.1', { own: [] }).kind, 'public');
  assert.strictEqual(network.describe('100.72.3.4', { own: [] }).kind, 'shared');
  assert.strictEqual(network.describe('169.254.10.1', { own: [] }).kind, 'link-local');
  assert.strictEqual(network.describe('127.0.0.1', { own: [] }).kind, 'loopback');
  assert.strictEqual(network.describe('::ffff:192.168.1.9', { own: [] }).address, '192.168.1.9', 'IPv4-mapped IPv6 is IPv4');
  assert.strictEqual(network.describe('nonsense', { own: [] }), null);
});

test('IPv6 addresses get their groups, a /64 segment and their kind', () => {
  const a = network.describe('fd12:3456:0:0:0:0:0:1', { own: [] });
  assert.strictEqual(a.address, 'fd12:3456::1');
  assert.strictEqual(a.segment, 'fd12:3456::/64');
  assert.strictEqual(a.kind, 'private');
  assert.strictEqual(network.describe('2001:db8:1:2::5', { bits6: 48, own: [] }).segment, '2001:db8:1::/48');
  assert.strictEqual(network.describe('::1', { own: [] }).kind, 'loopback');
  assert.strictEqual(network.describe('fe80::1%en0', { own: [] }).kind, 'link-local');
});

test('an address on one of this computer\'s segments names the adapter', () => {
  const own = network.interfaces(() => ({ en0: [{ address: '10.42.7.5', family: 'IPv4', cidr: '10.42.7.5/23', internal: false }], lo0: [{ address: '127.0.0.1', family: 'IPv4', cidr: '127.0.0.1/8', internal: true }] }));
  assert.deepStrictEqual(network.describe('10.42.6.200', { own }).ownSegment, { adapter: 'en0', cidr: '10.42.6.0/23' });
  assert.strictEqual(network.describe('10.43.0.1', { own }).ownSegment, null);
  assert.deepStrictEqual(network.adapterOf('10.42.7.5', own), { address: '10.42.7.5', adapter: 'en0', cidr: '10.42.6.0/23' });
});

// A resolver that answers like DNS would, without the network.
const fakeResolver = (overrides = {}) => ({
  lookup: async () => [{ address: '10.42.7.31', family: 4 }, { address: '10.43.1.9', family: 4 }],
  resolveCname: async (name) => ({ 'orders.corp': ['orders-lb.dc2.corp'], 'orders-lb.dc2.corp': ['orders-lb-1.dc2.corp'] }[name] || Promise.reject(Object.assign(new Error('no'), { code: 'ENODATA' }))),
  resolve4: async (name) => (name === 'orders-lb-1.dc2.corp' ? [{ address: '10.42.7.31', ttl: 30 }, { address: '10.43.1.9', ttl: 30 }] : []),
  resolve6: async () => Promise.reject(new Error('none')),
  reverse: async (ip) => (ip === '10.42.7.31' ? ['orders-7.rack12.dc2.corp'] : []),
  ...overrides,
});

test('a name is followed through its aliases to every address, with TTLs', async () => {
  const r = await network.resolveHost('orders.corp', { resolver: fakeResolver() });
  assert.deepStrictEqual(r.cnames, ['orders-lb.dc2.corp', 'orders-lb-1.dc2.corp']);
  assert.deepStrictEqual(r.addresses.map((a) => [a.address, a.ttl]), [['10.42.7.31', 30], ['10.43.1.9', 30]]);
  assert.strictEqual(r.splitDns, false);
});

test('split DNS is noticed when the resolver and DNS servers disagree', async () => {
  const r = await network.resolveHost('split.corp', { resolver: fakeResolver({ resolveCname: async () => [], resolve4: async () => [{ address: '203.0.113.5', ttl: 300 }] }) });
  assert.strictEqual(r.splitDns, true);
  assert.deepStrictEqual(r.direct, ['203.0.113.5']);
});

test('a trace marks the address connected to and its reverse-DNS name', async () => {
  const t = await network.trace({ url: 'https://orders.corp:8443/orders/1', remoteAddress: '10.42.7.31', localAddress: '10.42.7.5' },
    { resolver: fakeResolver(), interfaces: network.interfaces(() => ({ en0: [{ address: '10.42.7.5', family: 'IPv4', cidr: '10.42.7.5/24' }] })) });
  assert.strictEqual(t.host, 'orders.corp');
  assert.deepStrictEqual(t.connected.ptr, ['orders-7.rack12.dc2.corp']);
  assert.strictEqual(t.connected.segment, '10.42.7.0/24');
  assert.deepStrictEqual(t.resolution.addresses.map((a) => a.used), [true, false]);
  const { address, adapter, cidr, kind, octets, segment } = t.local;
  assert.deepStrictEqual({ address, adapter, cidr, kind, octets: [...octets], segment }, { address: '10.42.7.5', adapter: 'en0', cidr: '10.42.7.0/24', kind: 'private', octets: [10, 42, 7, 5], segment: '10.42.7.0/24' }, 'this computer\'s end, described like any address');
});

test('traceroute output from macOS/Linux and Windows is read hop by hop', () => {
  const unix = 'traceroute to 10.43.1.9 (10.43.1.9), 20 hops max\n 1  10.42.7.1  0.512 ms\n 2  *\n 3  10.43.1.9  2.104 ms\n';
  assert.deepStrictEqual(network.parseRoute(unix), [{ hop: 1, address: '10.42.7.1', ms: 0.512 }, { hop: 2, address: null, ms: null }, { hop: 3, address: '10.43.1.9', ms: 2.104 }]);
  const win = '\r\nTracing route to 10.43.1.9 over a maximum of 20 hops\r\n\r\n  1    <1 ms    <1 ms    <1 ms  10.42.7.1\r\n  2     *        *        *     Request timed out.\r\n  3     3 ms     2 ms     2 ms  10.43.1.9\r\n\r\nTrace complete.\r\n';
  assert.deepStrictEqual(network.parseRoute(win), [{ hop: 1, address: '10.42.7.1', ms: 1 }, { hop: 2, address: null, ms: null }, { hop: 3, address: '10.43.1.9', ms: 2 }]);
});

test('traceroute runs the system command without a shell, and refuses odd host names', async () => {
  let called;
  const hops = await network.traceRoute('10.43.1.9', { platform: 'darwin', run: (cmd, args, o, cb) => { called = [cmd, args]; cb(null, ' 1  10.43.1.9  1.0 ms\n', ''); } });
  assert.strictEqual(called[0], 'traceroute');
  assert.ok(called[1].includes('-n'));
  assert.strictEqual(hops[0].segment, '10.43.1.0/24');
  await assert.rejects(network.traceRoute('a.corp; rm -rf /', { run: () => assert.fail('must not run') }), /Not a host/);
  await assert.rejects(network.traceRoute('x.corp', { platform: 'win32', run: (cmd, a, o, cb) => cb(Object.assign(new Error('spawn'), { code: 'ENOENT' }), '', '') }), /tracert is not installed/);
});

test('traffic is also counted by the network segment that answered', () => {
  const pools = { orders_url: { sourceId: 'seg-test', service: 'orders', strategy: 'round-robin', default: 'http://orders', instances: [{ id: 'o1', url: 'http://a' }, { id: 'o2', url: 'http://b' }] } };
  const send = (address, time) => {
    const picks = new Map();
    const vars = balancer.bind({ orders_url: 'http://orders' }, pools, picks);
    void vars.orders_url;
    balancer.settle(picks, pools, { response: { status: 200, time, remoteAddress: address, headers: [] } });
  };
  send('10.42.7.31', 20);
  send('10.43.1.9', 300);
  send('10.42.7.32', 22);
  const m = balancer.metrics('seg-test');
  const seg = Object.fromEntries(m.bySegment.map((r) => [r.segment, r.requests]));
  assert.deepStrictEqual(seg, { '10.42.7.0/24': 2, '10.43.1.0/24': 1 });
  assert.ok(m.recent.every((r) => r.address));
  balancer.reset('seg-test');
});

test('a request\'s result says where it went', async () => {
  const srv = await startServer();
  try {
    const res = await execute({ request: { method: 'GET', url: `${srv.base}/get`, params: [], headers: [], body: { mode: 'none' } }, chain: [], scopes: { globals: {}, collection: {}, environment: {}, data: {} }, settings: {} });
    assert.strictEqual(res.network.connected.kind, 'loopback');
    assert.ok(res.network.local && res.network.local.address, 'the local address it left from');
    const off = await execute({ request: { method: 'GET', url: `${srv.base}/get`, params: [], headers: [], body: { mode: 'none' } }, chain: [], scopes: { globals: {}, collection: {}, environment: {}, data: {} }, settings: { traceNetwork: false } });
    assert.strictEqual(off.network, undefined);
  } finally { srv.server.close(); }
});
