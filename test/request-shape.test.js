'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shapesOf, checkRequest, findShape } = require('../src/core/request-shape');

const spec = {
  openapi: '3.1.0', info: { title: 'Lots', version: '2.0' },
  components: { schemas: { Payment: { type: 'object', required: ['order', 'amount'], properties: { order: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', enum: ['EUR', 'USD'] } }, additionalProperties: false } } },
  paths: {
    '/lots_for_erp': { get: { parameters: [{ name: 'state', in: 'query', required: true, schema: { type: 'string', enum: ['planned', 'released'] } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }] } },
    '/lots/{id}': { parameters: [{ name: 'id', in: 'path', required: true }], get: { deprecated: true, parameters: [{ name: 'X-Plant', in: 'header', required: true }] } },
    '/payments': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } } } },
  },
};
const shapes = shapesOf(spec);
const def = (o) => ({ method: 'GET', url: '{{lots_url}}/lots_for_erp', params: [], headers: [], body: { mode: 'none' }, ...o });
const q = (pairs) => pairs.map(([key, value, enabled = true]) => ({ key, value, enabled }));

test('each operation keeps its parameters, required fields and enums', () => {
  assert.deepStrictEqual(Object.keys(shapes), ['GET /lots_for_erp', 'GET /lots/{id}', 'POST /payments']);
  assert.deepStrictEqual(shapes['GET /lots_for_erp'].query.state, { required: true, enum: ['planned', 'released'], type: ['string'] });
  assert.strictEqual(shapes['GET /lots/{id}'].deprecated, true);
  assert.deepStrictEqual(shapes['POST /payments'].body.required, ['order', 'amount']);
});

test('a request that fits has no issues; one that drifted from the spec says how', () => {
  const s = shapes['GET /lots_for_erp'];
  assert.deepStrictEqual(checkRequest(def({ params: q([['state', 'released'], ['limit', '5']]) }), s), []);
  assert.deepStrictEqual(checkRequest(def({ params: q([['state', '{{state}}']]) }), s), [], 'variables are taken on trust');
  assert.deepStrictEqual(checkRequest(def({ params: q([['limit', '5'], ['dir', 'asc'], ['state', 'x', false]]) }), s).map((i) => [i.level, i.message]), [
    ['error', 'Missing required query parameter "state"'],
    ['warning', 'Query parameter "dir" is not in the spec'],
  ]);
  assert.match(checkRequest(def({ params: q([['state', 'closed']]) }), s)[0].message, /the spec allows "planned", "released"/);
  const lot = checkRequest(def({ url: '{{lots_url}}/lots/L1' }), shapes['GET /lots/{id}']).map((i) => i.message);
  assert.deepStrictEqual(lot, ['GET /lots/{id} is deprecated in the spec', 'Missing required header "x-plant"']);
});

test('JSON bodies: required fields, unknown fields, types and enums', () => {
  const s = shapes['POST /payments'];
  const body = (raw) => def({ method: 'POST', url: '{{lots_url}}/payments', body: { mode: 'raw', rawLanguage: 'json', raw } });
  assert.deepStrictEqual(checkRequest(body('{"order":"O1","amount":12.5,"currency":"EUR"}'), s), []);
  assert.deepStrictEqual(checkRequest(body('{"order":"{{orderId}}","amount":{{amount}}}'), s), []);
  assert.deepStrictEqual(checkRequest(body('{"order":"O1","amount":"12","currency":"GBP","note":"x"}'), s).map((i) => i.message), [
    'Body field "amount" is string; the spec says number',
    'Body field "currency" is "GBP"; the spec allows "EUR", "USD"',
    'Body field "note" is not in the spec',
  ]);
  assert.deepStrictEqual(checkRequest(body('{"amount":1}'), s).map((i) => i.message), ['Missing required body field "order"']);
});

test('requests are matched to their operation by the op they came from, or by method and path', () => {
  assert.strictEqual(findShape(def({}), shapes, { op: 'GET /lots_for_erp' }).shape.path, '/lots_for_erp');
  assert.deepStrictEqual(findShape(def({}), shapes, { op: 'GET /gone' }), { key: 'GET /gone', shape: null });
  assert.strictEqual(findShape(def({ url: '{{lots_url}}/lots/L-77?x=1' }), shapes, { variable: 'lots_url' }).key, 'GET /lots/{id}');
  assert.strictEqual(findShape(def({ url: '{{lots_url}}/lots/:id' }), shapes, { variable: 'lots_url' }).key, 'GET /lots/{id}');
  assert.deepStrictEqual(findShape(def({ method: 'DELETE', url: '{{lots_url}}/lots_for_erp' }), shapes, { variable: 'lots_url' }), { key: 'DELETE /lots_for_erp', shape: null });
  assert.strictEqual(findShape(def({ url: 'https://elsewhere.example/x' }), shapes, { variable: 'lots_url' }), null, 'not for this API');
});
