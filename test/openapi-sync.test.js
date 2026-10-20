'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCollection, mergeCollection, operations, secretVariables } = require('../src/core/openapi-sync');

const clone = (o) => JSON.parse(JSON.stringify(o));
const requests = (col) => {
  const out = [];
  const walk = (items) => items.forEach((i) => (i.type === 'folder' ? walk(i.items) : out.push(i)));
  walk(col.items);
  return out;
};
const byOp = (col, op) => requests(col).find((r) => r.openapi && r.openapi.op === op);
const byName = (col, name) => requests(col).find((r) => r.name === name);

const v1 = {
  openapi: '3.1.0',
  info: { title: 'Lots API', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:9090/svc/v1' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearer: [] }],
  paths: {
    '/lots_for_erp': { get: { summary: 'Lots for ERP', tags: ['lots'], parameters: [
      { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
    ] } },
    '/lots/{id}': { put: { summary: 'Update lot', tags: ['lots'], parameters: [{ name: 'id', in: 'path', required: true }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { qty: { type: 'integer' } } } } } } } },
    '/health': { get: { summary: 'Health', security: [] } },
    '/old': { get: { summary: 'Old report', tags: ['reports'] } },
    '/legacy': { get: { summary: 'Legacy' } },
  },
};

// Version 2: a new param and a changed default, a changed body, a renamed operation, a new
// operation, and two operations gone.
const v2 = clone(v1);
v2.info.version = '2.0.0';
v2.paths['/lots_for_erp'].get.parameters.push({ name: 'sort', in: 'query', schema: { type: 'string' } });
v2.paths['/lots_for_erp'].get.parameters[1].schema.default = 100;
v2.paths['/lots/{id}'].put.requestBody.content['application/json'].schema.properties.note = { type: 'string' };
v2.paths['/health'].get.summary = 'Health check';
v2.paths['/lots/{id}/history'] = { get: { summary: 'Lot history', tags: ['lots'], parameters: [{ name: 'id', in: 'path', required: true }] } };
delete v2.paths['/old'];
delete v2.paths['/legacy'];

test('the generated collection uses the source\'s base URL variable and tags every operation', () => {
  const col = buildCollection(v1, { variable: 'lots_api_url' });
  assert.ok(!col.variables.some((v) => v.key === 'baseUrl'));
  assert.deepStrictEqual(col.variables.map((v) => v.key), ['token']);
  const lots = byOp(col, 'GET /lots_for_erp');
  assert.strictEqual(lots.request.url, '{{lots_api_url}}/lots_for_erp?state');
  assert.strictEqual(byOp(col, 'PUT /lots/{id}').request.url, '{{lots_api_url}}/lots/:id');
  assert.deepStrictEqual(col.openapi.spec, { title: 'Lots API', version: '1.0.0', format: 'OpenAPI 3.1.0', hash: col.openapi.spec.hash });
  assert.deepStrictEqual(operations(col).map((o) => `${o.method} ${o.path} [${o.folder}]`).sort(),
    ['GET /health []', 'GET /legacy []', 'GET /lots_for_erp [lots]', 'GET /old [reports]', 'PUT /lots/{id} [lots]']);
  assert.deepStrictEqual(secretVariables(col, 'Bearer abc'), [{ key: 'token', value: 'abc' }]);
  assert.deepStrictEqual(secretVariables(col, '{{token}}'), []);
  assert.deepStrictEqual(secretVariables(col, ''), []);
});

test('a first sync adds everything; the same document again changes nothing', () => {
  const first = mergeCollection(null, buildCollection(v1, { variable: 'lots_api_url' }), { sourceId: 's1' });
  assert.strictEqual(first.diff.added.length, 5);
  assert.strictEqual(first.diff.spec.previous, null);
  assert.strictEqual(first.collection.openapi.sourceId, 's1');
  const before = clone(first.collection);
  const again = mergeCollection(clone(before), buildCollection(v1, { variable: 'lots_api_url' }), { sourceId: 's1' });
  assert.strictEqual(again.diff.spec.unchanged, true);
  assert.deepStrictEqual(again.diff.changes, []);
  assert.deepStrictEqual(again.diff.collection, []);
  // Only fresh example ids could differ, and they're kept by name.
  assert.deepStrictEqual(again.collection, before);
});

test('a new version is reported change by change, and the user\'s work is kept', () => {
  const { collection } = mergeCollection(null, buildCollection(v1, { variable: 'lots_api_url' }), { sourceId: 's1' });
  const col = clone(collection);
  // The user: types a state, writes a test, edits a body, renames the collection, adds a request,
  // and changes the request for an operation that's about to go.
  const lots = byOp(col, 'GET /lots_for_erp');
  lots.request.params[0].value = 'released';
  lots.request.url = '{{lots_api_url}}/lots_for_erp?state=released';
  lots.request.testScript = 'pm.test("ok", () => pm.response.to.have.status(200));';
  byOp(col, 'PUT /lots/{id}').request.body.raw = '{ "qty": 5 }';
  byOp(col, 'PUT /lots/{id}').request.pathVariables[0].value = 'LOT-1';
  byOp(col, 'GET /legacy').request.description = 'Still used by the night job';
  col.name = 'MES lots';
  col.items.push({ id: 'mine', type: 'request', name: 'My own request', request: { method: 'GET', url: 'https://example.com', params: [], headers: [], pathVariables: [], body: { mode: 'none' }, auth: { type: 'inherit' } } });

  const preview = mergeCollection(clone(col), buildCollection(v2, { variable: 'lots_api_url' }), { sourceId: 's1' });
  const { diff } = preview;
  assert.strictEqual(diff.spec.previous.version, '1.0.0');
  assert.strictEqual(diff.spec.current.version, '2.0.0');
  assert.strictEqual(diff.spec.unchanged, false);
  assert.strictEqual(diff.spec.sameVersion, false);
  const change = (op) => diff.changes.find((c) => c.op === op);
  assert.deepStrictEqual(change('GET /lots_for_erp').details, ['query param changed: limit', 'query param added: sort']);
  assert.deepStrictEqual(change('PUT /lots/{id}'), { kind: 'changed', op: 'PUT /lots/{id}', name: 'Update lot', details: ['body changed'], kept: ['body'] });
  assert.deepStrictEqual(change('GET /health').details, ['renamed to "Health check"', 'description changed']); // its summary is its description
  assert.strictEqual(change('GET /lots/{id}/history').kind, 'added');
  assert.strictEqual(change('GET /old').kind, 'removed');
  assert.strictEqual(change('GET /legacy').kind, 'kept');
  assert.deepStrictEqual(diff.collection, []); // the collection's name is the user's, and the spec's title didn't change

  const out = preview.collection;
  const lots2 = byOp(out, 'GET /lots_for_erp');
  assert.strictEqual(lots2.request.testScript, lots.request.testScript);
  assert.deepStrictEqual(lots2.request.params.map((p) => [p.key, p.value, p.enabled]), [['state', 'released', true], ['limit', '100', false], ['sort', '', false]]);
  assert.strictEqual(lots2.request.url, '{{lots_api_url}}/lots_for_erp?state=released');
  const put = byOp(out, 'PUT /lots/{id}');
  assert.strictEqual(put.request.body.raw, '{ "qty": 5 }');
  assert.strictEqual(put.request.pathVariables[0].value, 'LOT-1');
  assert.strictEqual(byOp(out, 'GET /health').name, 'Health check');
  assert.ok(byOp(out, 'GET /lots/{id}/history'));
  assert.strictEqual(byName(out, 'Old report'), undefined);
  assert.ok(!out.items.some((i) => i.type === 'folder' && i.name === 'reports'), 'the emptied tag folder goes');
  const legacy = byName(out, 'Legacy');
  assert.strictEqual(legacy.openapi, undefined);
  assert.strictEqual(legacy.request.description, 'Still used by the night job');
  assert.ok(byName(out, 'My own request'));
  assert.strictEqual(out.name, 'MES lots');

  // The spec's later change to a body the user hadn't touched follows the spec; their body edit stays theirs.
  const v3 = clone(v2);
  v3.info.version = '3.0.0';
  v3.paths['/lots/{id}/history'].get.parameters.push({ name: 'days', in: 'query', required: true, example: 7 });
  const next = mergeCollection(clone(out), buildCollection(v3, { variable: 'lots_api_url' }), { sourceId: 's1' });
  assert.deepStrictEqual(next.diff.changes.map((c) => [c.op, c.details]), [['GET /lots/{id}/history', ['query param added: days']]]);
  assert.strictEqual(byOp(next.collection, 'GET /lots/{id}/history').request.url, '{{lots_api_url}}/lots/:id/history?days=7');
  assert.strictEqual(byOp(next.collection, 'PUT /lots/{id}').request.body.raw, '{ "qty": 5 }');
});

test('a document that changed without a new version number is flagged', () => {
  const { collection } = mergeCollection(null, buildCollection(v1, { variable: 'api_url' }), {});
  const quiet = clone(v1);
  quiet.paths['/health'].get.description = 'Returns 200 when up';
  const { diff } = mergeCollection(collection, buildCollection(quiet, { variable: 'api_url' }), {});
  assert.strictEqual(diff.spec.sameVersion, true);
  assert.deepStrictEqual(diff.changes.map((c) => [c.op, c.details]), [['GET /health', ['description changed']]]);
});

test('renaming the base URL variable moves the URLs the user hasn\'t edited', () => {
  const { collection } = mergeCollection(null, buildCollection(v1, { variable: 'api_url' }), {});
  byOp(collection, 'GET /legacy').request.url = 'https://elsewhere.example.com/legacy';
  const { collection: out } = mergeCollection(collection, buildCollection(v1, { variable: 'lots_url' }), {});
  assert.strictEqual(byOp(out, 'GET /health').request.url, '{{lots_url}}/health');
  assert.strictEqual(byOp(out, 'GET /legacy').request.url, 'https://elsewhere.example.com/legacy');
});
