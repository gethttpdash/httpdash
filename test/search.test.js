'use strict';

// The renderer's request search (tags, methods, URLs, names), loaded with a minimal HD.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = { collections: [] };
global.HD = {
  h: () => ({}), S: { ws },
  walk: (items, fn, parents = []) => { for (const it of items) { fn(it, parents); if (it.type === 'folder') global.HD.walk(it.items, fn, [...parents, it]); } },
};
new Function(fs.readFileSync(path.join(__dirname, '../src/renderer/js/search.js'), 'utf8'))();
const { matchRequest, normalizeTags, requestCatalog } = global.HD;

const req = (name, method, url, tags = []) => ({ type: 'request', name, request: { method, url, tags } });
const list = req('List orders', 'GET', '{{orders_url}}/orders?state=released', ['orders', 'smoke']);
const create = req('Create order', 'POST', '{{orders_url}}/orders', ['orders']);
const pay = req('Take payment', 'POST', '{{payments_url}}/payments', ['payments', 'Smoke']);
ws.collections.push({ type: 'collection', name: 'Shop', items: [{ type: 'folder', name: 'Orders', items: [list, create] }, pay] });

const names = (query) => [list, create, pay].filter((r) => matchRequest(r, query)).map((r) => r.name);

test('every tag must be on the request; any one method will do; URL, name and text must all match', () => {
  assert.deepStrictEqual(names({ tokens: [{ kind: 'tag', value: 'smoke' }] }), ['List orders', 'Take payment'], 'tags ignore case');
  assert.deepStrictEqual(names({ tokens: [{ kind: 'tag', value: 'smoke' }, { kind: 'tag', value: 'orders' }] }), ['List orders']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'method', value: 'GET' }, { kind: 'method', value: 'POST' }] }), ['List orders', 'Create order', 'Take payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'method', value: 'POST' }, { kind: 'url', value: '/orders' }] }), ['Create order']);
  assert.deepStrictEqual(names({ tokens: [], text: 'pay' }), ['Take payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'text', value: 'smok' }] }), ['List orders', 'Take payment'], 'text also finds tags');
  assert.deepStrictEqual(names({ tokens: [{ kind: 'name', value: 'order' }], text: 'released' }), ['List orders']);
  assert.deepStrictEqual(names({ tokens: [], text: '' }), ['List orders', 'Create order', 'Take payment']);
});

test('the catalog counts tags (ignoring case), methods, URLs without their query, and names', () => {
  const c = requestCatalog();
  assert.deepStrictEqual(c.tags.map((t) => [t.value, t.count]), [['orders', 2], ['smoke', 2], ['payments', 1]]);
  assert.deepStrictEqual(c.methods.map((m) => [m.value, m.count]), [['POST', 2], ['GET', 1]]);
  assert.deepStrictEqual(c.urls.map((u) => [u.value, u.count]), [['{{orders_url}}/orders', 2], ['{{payments_url}}/payments', 1]]);
});

test('tags are trimmed, comma-free, unique ignoring case, short and few', () => {
  assert.deepStrictEqual(normalizeTags([' smoke ', 'Smoke', 'a,b', '', 'x'.repeat(50)]), ['smoke', 'a b', 'x'.repeat(40)]);
  assert.strictEqual(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
});
