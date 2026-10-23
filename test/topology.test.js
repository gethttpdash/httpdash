'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { build, hostsToResolve } = require('../src/core/topology');

const row = (o) => ({ requests: 10, errors: 0, status: { '2xx': 10 }, p50: 20, p95: 40, ...o });
const byId = (g, id) => g.nodes.find((n) => n.id === id);
const into = (g, id) => g.edges.filter((e) => e.to === id);
const outOf = (g, id) => g.edges.filter((e) => e.from === id);

const podsSource = {
  id: 's1', name: 'Shop cluster', provider: 'kubernetes', addressMode: 'pods', balance: 'round-robin',
  lastSync: { services: [{
    name: 'orders', variable: 'orders_url', url: 'http://10.244.0.5:8080', cluster: { kind: 'kubernetes', namespace: 'shop', name: 'orders', type: 'ClusterIP', clusterIp: '10.96.0.10' },
    instances: [
      { id: 'orders-a', url: 'http://10.244.0.5:8080', healthy: true, address: '10.244.0.5', node: 'node-1', namespace: 'shop' },
      { id: 'orders-b', url: 'http://10.244.0.6:8080', healthy: true, address: '10.244.0.6', node: 'node-1', namespace: 'shop' },
      { id: 'orders-c', url: 'http://10.244.1.7:8080', healthy: false, address: '10.244.1.7', node: 'node-2', namespace: 'shop' },
    ],
  }] },
};

test('discovered pods: endpoint, HttpDash spreading the requests, and pods grouped by namespace and segment', () => {
  const g = build({
    environment: { values: [{ key: 'orders_url', value: 'http://10.244.0.5:8080', enabled: true, discovered: 's1' }] },
    sources: [podsSource],
    metrics: { s1: { rows: [
      row({ variable: 'orders_url', service: 'orders', instance: 'http://10.244.0.5:8080', instanceId: 'orders-a', requests: 30, p95: 40 }),
      row({ variable: 'orders_url', service: 'orders', instance: 'http://10.244.0.6:8080', instanceId: 'orders-b', requests: 10, p95: 300 }),
    ] } },
  });
  assert.deepStrictEqual(g.nodes.map((n) => n.kind), ['client', 'endpoint', 'balancer', 'instance', 'instance', 'instance']);
  const ep = byId(g, 'ep:orders_url');
  assert.strictEqual(ep.label, '{{orders_url}}');
  assert.strictEqual(ep.detail, '10.244.0.5:8080');
  assert.strictEqual(ep.requests, 40, 'the endpoint carries the traffic of its instances');
  const lb = byId(g, 'lb:ep:orders_url');
  assert.strictEqual(lb.label, 'HttpDash');
  assert.strictEqual(lb.detail, 'round robin over 3 instances');
  assert.match(lb.meta.spreads, /each instance in turn/);
  const a = byId(g, 'in:ep:orders_url:orders-a');
  const b = byId(g, 'in:ep:orders_url:orders-b');
  const c = byId(g, 'in:ep:orders_url:orders-c');
  assert.deepStrictEqual([a.stats.requests, a.stats.share], [30, 0.75]);
  assert.deepStrictEqual(b.flags, ['slow'], "much slower than its sibling");
  assert.deepStrictEqual([c.health, c.flags], ['down', ['unhealthy']]);
  assert.strictEqual(c.stats, null, 'no traffic yet');
  assert.deepStrictEqual(g.groups.map((x) => x.label), ['namespace shop · 10.244.0.0/24', 'namespace shop · 10.244.1.0/24']);
  assert.strictEqual(a.group, b.group);
  assert.notStrictEqual(a.group, c.group);
  assert.strictEqual(g.groups[0].kind, 'private');
  assert.deepStrictEqual(outOf(g, 'lb:ep:orders_url').map((e) => [e.requests, e.state]), [[30, 'ok'], [10, 'ok'], [0, 'idle']]);
  assert.deepStrictEqual(into(g, 'ep:orders_url').map((e) => e.requests), [40]);
});

test('a Kubernetes Service in front of pods that are not listed', () => {
  const src = {
    id: 's2', name: 'k8s', provider: 'kubernetes', addressMode: 'cluster-dns',
    lastSync: { services: [{ name: 'cart', variable: 'cart_url', url: 'http://cart.shop.svc.cluster.local:8080', cluster: { kind: 'kubernetes', namespace: 'shop', name: 'cart', type: 'LoadBalancer', clusterIp: '10.96.0.11', external: 'cart.example.com' },
      instances: [{ id: 'cart', url: 'http://cart.shop.svc.cluster.local:8080', healthy: true, namespace: 'shop' }] }] },
  };
  const g = build({ environment: { values: [{ key: 'cart_url', value: 'http://cart.shop.svc.cluster.local:8080', discovered: 's2' }] }, sources: [src] });
  const lb = byId(g, 'lb:ep:cart_url');
  assert.strictEqual(lb.label, 'Service cart');
  assert.strictEqual(lb.detail, 'Kubernetes · LoadBalancer · 10.96.0.11 · cart.example.com');
  const pods = g.nodes.find((n) => n.kind === 'instance');
  assert.deepStrictEqual([pods.label, pods.flags], ['pods behind cart', ['hidden']]);
  assert.match(pods.detail, /Pods address mode/);
  assert.deepStrictEqual(g.groups.map((x) => x.label), ['namespace shop']);
});

test('behind a load balancer, the backends are the ones the instance header named', () => {
  const src = {
    id: 's3', name: 'Consul', provider: 'consul', instanceHeader: 'X-Served-By',
    lastSync: { services: [{ name: 'pay', variable: 'pay_url', url: 'http://10.0.9.1:80', instances: [{ id: 'pay-lb', url: 'http://10.0.9.1:80', healthy: true, address: '10.0.9.1', dc: 'dc1' }] }] },
  };
  const rows = [
    row({ variable: 'pay_url', service: 'pay', instance: 'http://10.0.9.1:80', instanceId: 'pay-lb', servedBy: 'pay-1', requests: 6, address: '10.0.9.1' }),
    row({ variable: 'pay_url', service: 'pay', instance: 'http://10.0.9.1:80', instanceId: 'pay-lb', servedBy: 'pay-2', requests: 6, errors: 3, status: { '2xx': 1, '5xx': 2 }, address: '10.0.9.1' }),
  ];
  const g = build({ environment: { values: [{ key: 'pay_url', value: 'http://10.0.9.1:80', discovered: 's3' }] }, sources: [src], metrics: { s3: { rows } } });
  const lb = byId(g, 'lbh:ep:pay_url');
  assert.strictEqual(lb.label, 'Load balancer');
  assert.match(lb.detail, /X-Served-By/);
  const backends = outOf(g, lb.id).map((e) => byId(g, e.to));
  assert.deepStrictEqual(backends.map((n) => n.label), ['pay-1', 'pay-2']);
  assert.deepStrictEqual(byId(g, 'in:ep:pay_url:sb:pay-2').flags, ['failing'], '5 of 6 failed');
  assert.deepStrictEqual(outOf(g, lb.id).map((e) => e.state), ['ok', 'errors']);
  assert.strictEqual(g.groups[0].label, '10.0.9.0/24', 'grouped by where the balancer answered from');
});

test('an instance that answered but left the registry; a variable set by hand; a tunnel', () => {
  const src = {
    id: 's4', name: 'Eureka', provider: 'eureka', balance: 'random',
    lastSync: { services: [{ name: 'users', variable: 'users_url', url: 'http://10.1.0.2:80', instances: [
      { id: 'u-1', url: 'http://10.1.0.2:80', healthy: true, address: '10.1.0.2', zone: 'eu-1a' },
      { id: 'u-2', url: 'http://10.1.0.3:80', healthy: true, address: '10.1.0.3', zone: 'eu-1a' },
    ] }, { name: 'billing', variable: 'billing_url', url: 'http://10.1.0.9:80', instances: [{ id: 'b-1', url: 'http://10.1.0.9:80', healthy: true }] }] },
  };
  const g = build({
    environment: { values: [
      { key: 'users_url', value: 'http://10.1.0.2:80', discovered: 's4' },
      { key: 'billing_url', value: 'http://localhost:9000', discovered: 's4' },
    ] },
    sources: [src],
    metrics: { s4: { rows: [row({ variable: 'users_url', service: 'users', instance: 'http://10.1.0.8:80', instanceId: 'u-old', address: '10.1.0.8' })] } },
    tunnel: { id: 't1', name: 'Plant jump host' },
  });
  assert.deepStrictEqual(outOf(g, 'client').map((e) => e.to), ['tunnel']);
  assert.deepStrictEqual(outOf(g, 'tunnel').map((e) => e.to), ['ep:users_url', 'ep:billing_url']);
  const left = byId(g, 'in:ep:users_url:left:u-old');
  assert.deepStrictEqual([left.detail, left.flags], ['left the pool', ['left']]);
  assert.strictEqual(byId(g, 'lb:ep:users_url').detail, 'random over 2 instances');
  assert.ok(g.groups.some((x) => x.label === 'zone eu-1a · 10.1.0.0/24'));
  const billing = byId(g, 'ep:billing_url');
  assert.strictEqual(billing.meta.byHand, true, "the variable doesn't hold the discovered URL any more");
  assert.deepStrictEqual(outOf(g, 'ep:billing_url').map((e) => byId(g, e.to).label), ['localhost:9000']);
});

test('URLs set by hand: their DNS addresses, a host that did not resolve, and what is left out', () => {
  const environment = { values: [
    { key: 'api_url', value: 'https://api.example.com', enabled: true },
    { key: 'internal_url', value: 'http://inventory.mes.corp:8080' },
    { key: 'ip_url', value: 'http://192.168.5.20:81' },
    { key: 'token', value: 'abc' },
    { key: 'secret_url', value: 'https://user:pw@vault.example.com', secret: true },
    { key: 'composed', value: '{{api_url}}/v2' },
    { key: 'off_url', value: 'https://off.example.com', enabled: false },
  ] };
  assert.deepStrictEqual(hostsToResolve(environment, []), ['api.example.com', 'inventory.mes.corp']);
  const g = build({
    environment,
    dns: { 'api.example.com': { addresses: [{ address: '203.0.113.10', ttl: 60 }, { address: '203.0.113.11', ttl: 60 }] }, 'inventory.mes.corp': { addresses: [], error: 'not found' } },
  });
  assert.deepStrictEqual(g.nodes.filter((n) => n.kind === 'endpoint').map((n) => n.label), ['{{api_url}}', '{{internal_url}}', '{{ip_url}}']);
  const dns = byId(g, 'lb:ep:api_url');
  assert.deepStrictEqual([dns.label, dns.detail], ['DNS', 'api.example.com has 2 addresses']);
  assert.deepStrictEqual(outOf(g, dns.id).map((e) => byId(g, e.to).label), ['203.0.113.10', '203.0.113.11']);
  assert.strictEqual(g.groups.find((x) => x.segment === '203.0.113.0/24').kind, 'public');
  assert.strictEqual(byId(g, 'in:ep:internal_url:inventory.mes.corp').detail, 'not resolved from this computer');
  assert.strictEqual(byId(g, 'in:ep:ip_url:192.168.5.20').detail, 'address in the URL');
});
