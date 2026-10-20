'use strict';

const test = require('node:test');
const assert = require('node:assert');
const postman = require('../src/core/postman');
const { startMockServer } = require('../src/core/mock');

const SPEC = `
openapi: 3.1.0
info:
  title: Shop API
  description: Orders and products
servers:
  - url: /api/v1
security:
  - bearerAuth: []
paths:
  /orders/{orderId}:
    parameters:
      - $ref: '#/components/parameters/OrderId'
    get:
      tags: [orders]
      summary: Get an order
      parameters:
        - name: expand
          in: query
          required: true
          schema: { type: string, default: items }
      responses:
        '200':
          description: The order
          content:
            application/vnd.api+json:
              schema: { $ref: '#/components/schemas/OrderAlias' }
        '404':
          description: Not found
          content:
            application/problem+json:
              examples:
                missing: { value: { title: No such order } }
  /orders:
    post:
      tags: [orders]
      summary: Create an order
      requestBody:
        content:
          application/json; charset=utf-8:
            examples:
              simple:
                value: { product: p-1, quantity: 2 }
      responses:
        '201': { description: Created }
        '204': { description: Nothing }
  /health:
    get:
      summary: Health
      security: []
      responses:
        '200':
          description: OK
          content:
            text/plain:
              example: ok
  /status:
    $ref: '#/paths/~1health'
  /products/search:
    get:
      summary: Search products
      security:
        - oauth: [products:read]
      responses: {}
components:
  parameters:
    OrderId:
      name: orderId
      in: path
      required: true
      example: o-42
      schema: { type: string }
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
    oauth:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://auth.example.com/authorize
          tokenUrl: https://auth.example.com/token
          scopes: { products:read: read products }
  schemas:
    OrderAlias: { $ref: '#/components/schemas/Order' }
    Order:
      type: object
      properties:
        id: { type: string, format: uuid }
        note: { type: [string, 'null'] }
        total: { type: number }
        created: { type: string, format: date-time }
`;

const find = (col, name) => {
  const walk = (items) => items.flatMap((i) => (i.type === 'folder' ? walk(i.items) : [i]));
  return walk(col.items).find((i) => i.name === name);
};

test('YAML OpenAPI 3.1 specs import with refs, examples and auth', () => {
  const { kind, data: col } = postman.importText(SPEC);
  assert.strictEqual(kind, 'collection');
  assert.strictEqual(col.name, 'Shop API');
  assert.strictEqual(col.variables.find((v) => v.key === 'baseUrl').value, 'http://localhost/api/v1');
  assert.ok(col.variables.some((v) => v.key === 'token'));
  assert.deepStrictEqual(col.auth, { type: 'bearer', bearer: { token: '{{token}}' } });

  const get = find(col, 'Get an order');
  assert.strictEqual(get.request.url, '{{baseUrl}}/orders/:orderId?expand=items');
  assert.strictEqual(get.request.pathVariables[0].value, 'o-42');
  assert.strictEqual(get.request.auth.type, 'inherit');
  const ok = get.examples.find((e) => e.status === 200);
  assert.deepStrictEqual(JSON.parse(ok.body), { id: '00000000-0000-0000-0000-000000000000', note: 'string', total: 0, created: '1970-01-01T00:00:00.000Z' });
  assert.deepStrictEqual(ok.headers, [['Content-Type', 'application/vnd.api+json']]);
  assert.deepStrictEqual(JSON.parse(get.examples.find((e) => e.status === 404).body), { title: 'No such order' });

  const post = find(col, 'Create an order');
  assert.deepStrictEqual(JSON.parse(post.request.body.raw), { product: 'p-1', quantity: 2 });
  assert.ok(post.request.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json; charset=utf-8'));
  assert.deepStrictEqual(post.examples.map((e) => e.status), [204]);

  assert.strictEqual(find(col, 'Health').request.auth.type, 'none');
  // "/status" points at "/health" through a $ref with an escaped "/" (~1).
  const paths = col.items.filter((i) => i.name === 'Health').map((i) => i.request.url).sort();
  assert.deepStrictEqual(paths, ['{{baseUrl}}/health', '{{baseUrl}}/status']);
  const search = find(col, 'Search products');
  assert.strictEqual(search.request.url, '{{baseUrl}}/products/search');
  assert.strictEqual(search.request.auth.oauth2.grantType, 'authorization_code_with_pkce');
  assert.strictEqual(search.request.auth.oauth2.authUrl, 'https://auth.example.com/authorize');
  assert.strictEqual(search.request.auth.oauth2.scope, 'products:read');
});

test('imported response examples are served by the mock server', async () => {
  const { data: col } = postman.importText(SPEC);
  const mock = await startMockServer({ collection: col, port: 0 });
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const res = await fetch(`${base}/orders/o-1`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).total, 0);
    const missing = await fetch(`${base}/orders/o-1`, { headers: { 'x-mock-response-code': '404' } });
    assert.strictEqual(missing.status, 404);
  } finally {
    await mock.close();
  }
});

test('Swagger 2 YAML imports form fields and security', () => {
  const { data: col } = postman.importText(`
swagger: '2.0'
info: { title: Legacy }
host: legacy.example.com
basePath: /v2
schemes: [https]
securityDefinitions:
  key: { type: apiKey, name: X-Key, in: header }
security: [{ key: [] }]
paths:
  /upload:
    post:
      summary: Upload
      parameters:
        - { name: file, in: formData, type: file }
        - { name: title, in: formData, type: string }
      responses:
        '200': { description: OK, schema: { type: object, properties: { id: { type: integer } } } }
`);
  assert.strictEqual(col.variables[0].value, 'https://legacy.example.com/v2');
  assert.deepStrictEqual(col.auth, { type: 'apikey', apikey: { key: 'X-Key', value: '{{apiKey}}', in: 'header' } });
  const up = find(col, 'Upload');
  assert.strictEqual(up.request.body.mode, 'formdata');
  assert.deepStrictEqual(up.request.body.formdata.map((f) => [f.key, f.type]), [['file', 'file'], ['title', 'text']]);
  assert.deepStrictEqual(JSON.parse(up.examples[0].body), { id: 0 });
});

test('bad input is refused with a clear message', () => {
  assert.throws(() => postman.parseDocument('{"broken": '), /Invalid JSON/);
  assert.throws(() => postman.parseDocument('just text'), /Unrecognised file format/);
  // A "billion laughs" alias bomb is stopped instead of expanding.
  const bomb = ['a: &a [x,x,x,x,x,x,x,x,x]', ...Array.from({ length: 9 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`)].join('\n');
  assert.throws(() => postman.parseDocument(bomb), /JSON or YAML/);
  // JSON still works exactly as before.
  assert.strictEqual(postman.importText(JSON.stringify({ openapi: '3.0.0', info: { title: 'J' }, paths: {} })).data.name, 'J');
});
