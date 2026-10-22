'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { syncServiceCollections, findSpec, specPaths, collectionName, DEFAULT_PATHS } = require('../src/core/spec-collections');
const { fetchDocument } = require('../src/core/discovery');

const clone = (o) => JSON.parse(JSON.stringify(o));
const requests = (col) => {
  const out = [];
  const walk = (items) => items.forEach((i) => (i.type === 'folder' ? walk(i.items) : out.push(i)));
  walk(col.items);
  return out;
};

const ordersDoc = {
  openapi: '3.0.1',
  info: { title: 'OpenAPI definition', version: 'v0' },
  servers: [{ url: 'http://10.0.1.5:8080' }],
  paths: {
    '/orders': { get: { summary: 'List orders', tags: ['orders'] }, post: { summary: 'Create order', tags: ['orders'] } },
    '/orders/{id}': { get: { summary: 'Get order', tags: ['orders'], parameters: [{ name: 'id', in: 'path', required: true }] } },
  },
};
const lotsDoc = { swagger: '2.0', info: { title: 'Lots API', version: '1.2' }, paths: { '/lots': { get: { summary: 'List lots' } } } };

// Services that answer like Spring (/v3/api-docs), FastAPI (/openapi.json, YAML here), one without a
// document, and one that can't be reached.
const docs = {
  'http://orders:8080/v3/api-docs': ordersDoc,
  'http://lots:9000/openapi.json': lotsDoc,
};
const fetched = [];
const fetchDoc = async (url) => {
  fetched.push(url);
  if (url.startsWith('http://down:')) throw Object.assign(new Error(`Could not reach ${url}: connect ECONNREFUSED`), { unreachable: true });
  if (docs[url]) return clone(docs[url]);
  if (url === 'http://lots:9000/v3/api-docs') return { status: 'UP' }; // JSON, but not a document
  throw new Error(`${url} returned 404 Not Found`);
};
const services = [
  { name: 'orders', url: 'http://orders:8080', variable: 'orders_url' },
  { name: 'lots', url: 'http://lots:9000/', variable: 'lots_url' },
  { name: 'cache', url: 'http://cache:6379', variable: 'cache_url' },
  { name: 'billing', url: 'http://down:1', variable: 'billing_url' },
];

test('paths: what the user wrote, with a leading slash, or the common ones', () => {
  assert.deepStrictEqual(specPaths('/v3/api-docs, openapi.json'), ['/v3/api-docs', '/openapi.json']);
  assert.deepStrictEqual(specPaths('https://specs.internal/orders.json'), ['https://specs.internal/orders.json']);
  assert.deepStrictEqual(specPaths('  '), DEFAULT_PATHS);
});

test('a collection is named after the document, or the service when the title is a framework default', () => {
  assert.strictEqual(collectionName(ordersDoc, 'orders'), 'orders', 'springdoc calls every document "OpenAPI definition"');
  assert.strictEqual(collectionName(lotsDoc, 'lots'), 'Lots API');
  assert.strictEqual(collectionName({ info: {} }, 'cache'), 'cache');
});

test('the first path with a document wins; an unreachable service is not tried again', async () => {
  fetched.length = 0;
  const lots = await findSpec('http://lots:9000', ['/v3/api-docs', '/openapi.json'], fetchDoc);
  assert.strictEqual(lots.url, 'http://lots:9000/openapi.json', 'JSON that is not a document moves on');
  const down = await findSpec('http://down:1', ['/v3/api-docs', '/openapi.json'], fetchDoc);
  assert.ok(down.unreachable && /ECONNREFUSED/.test(down.error));
  assert.deepStrictEqual(fetched.filter((u) => u.startsWith('http://down')), ['http://down:1/v3/api-docs']);
  const none = await findSpec('http://cache:6379', ['/v3/api-docs', '/openapi.json'], fetchDoc);
  assert.match(none.error, /no API document at \/v3\/api-docs, \/openapi\.json/);
});

test('each service with a document gets a collection whose requests use its own variable', async () => {
  const { specs, missing } = await syncServiceCollections({ services, paths: specPaths('/v3/api-docs, /openapi.json'), sourceId: 'src1', fetchDoc });
  assert.deepStrictEqual(specs.map((x) => [x.service, x.status]), [['orders', 'synced'], ['lots', 'synced'], ['cache', 'none'], ['billing', 'unreachable']], 'in the services\' order');
  assert.deepStrictEqual(missing, []);
  const orders = specs[0];
  assert.strictEqual(orders.collection.name, 'orders');
  assert.strictEqual(orders.operations, 3);
  assert.deepStrictEqual(orders.requests.added.sort(), ['Create order', 'Get order', 'List orders']);
  assert.ok(requests(orders.collection).every((r) => r.request.url.startsWith('{{orders_url}}/orders')), 'the registry\'s variable, so load balancing applies');
  assert.deepStrictEqual(orders.collection.discoveredService, { sourceId: 'src1', service: 'orders' });
  assert.ok(orders.shapes && orders.spec && orders.docUrl === 'http://orders:8080/v3/api-docs');
  assert.strictEqual(specs[1].collection.name, 'Lots API');
  assert.ok(requests(specs[1].collection)[0].request.url.startsWith('{{lots_url}}'));
});

test('later syncs keep the user\'s edits, report what changed, skip or create, and list services that are gone', async () => {
  const first = await syncServiceCollections({ services, paths: specPaths(''), sourceId: 'src1', fetchDoc });
  const orders = first.specs.find((x) => x.service === 'orders').collection;
  const list = requests(orders).find((r) => r.name === 'List orders');
  list.request.testScript = 'pm.test("ok", () => pm.response.to.be.ok);';
  list.name = 'All orders';

  const same = await syncServiceCollections({ services, collections: { orders: clone(orders) }, paths: specPaths(''), sourceId: 'src1', fetchDoc });
  assert.strictEqual(same.specs[0].status, 'unchanged');

  docs['http://orders:8080/v3/api-docs'] = clone(ordersDoc);
  docs['http://orders:8080/v3/api-docs'].info.version = 'v1';
  docs['http://orders:8080/v3/api-docs'].paths['/orders/{id}'].delete = { summary: 'Cancel order', tags: ['orders'] };
  const next = await syncServiceCollections({ services, collections: { orders: clone(orders), legacy: { items: [] } }, paths: specPaths(''), sourceId: 'src1', fetchDoc });
  const o = next.specs[0];
  assert.strictEqual(o.status, 'synced');
  assert.deepStrictEqual(o.requests.added, ['Cancel order']);
  const kept = requests(o.collection).find((r) => r.openapi && r.openapi.op === 'GET /orders');
  assert.match(kept.request.testScript, /pm\.test/, 'scripts are never touched');
  assert.strictEqual(kept.name, 'All orders', 'a renamed request keeps its name');
  assert.deepStrictEqual(next.missing, ['legacy']);

  const startup = await syncServiceCollections({ services, collections: { orders: clone(orders) }, paths: specPaths(''), sourceId: 'src1', update: false, fetchDoc });
  assert.strictEqual(startup.specs[0].status, 'skipped', 'update: false leaves existing collections alone');
  assert.strictEqual(startup.specs[1].status, 'synced', 'and still creates the missing ones');
  docs['http://orders:8080/v3/api-docs'] = ordersDoc;
});

test('documents are fetched over HTTP as JSON or YAML, without the registry\'s credentials', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/openapi.yaml') { res.writeHead(200, { 'Content-Type': 'application/yaml' }); res.end('openapi: 3.0.0\ninfo:\n  title: Yaml API\n  version: "1"\npaths:\n  /x:\n    get:\n      summary: X\n'); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { specs } = await syncServiceCollections({
      services: [{ name: 'yaml-svc', url: base, variable: 'yaml_svc_url' }], paths: specPaths('/v3/api-docs, /openapi.yaml'), sourceId: 's',
      fetchDoc: (url) => fetchDocument(url, {}, {}),
    });
    assert.strictEqual(specs[0].status, 'synced');
    assert.strictEqual(specs[0].collection.name, 'Yaml API');
    assert.deepStrictEqual(seen.map((x) => x.url), ['/v3/api-docs', '/openapi.yaml']);
    assert.ok(seen.every((x) => !x.auth));
    await assert.rejects(fetchDocument('http://127.0.0.1:1/v3/api-docs', {}, {}), (e) => e.unreachable === true);
  } finally {
    server.close();
  }
});
