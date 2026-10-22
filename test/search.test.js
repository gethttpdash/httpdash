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

test('what is typed in an open tab counts before it is saved', () => {
  const { liveItem } = global.HD;
  list.id = 'list';
  ws.tabs = [
    // An edited, unsaved tab of a saved request: its new tag is found.
    { kind: 'request', refId: 'list', dirty: true, draft: { name: 'List orders', request: { method: 'GET', url: '{{orders_url}}/orders', tags: ['orders', 'smoke', 'cli'] } } },
    // A tab that isn't saved anywhere (a history copy).
    { id: 't2', kind: 'request', refId: null, draft: { name: 'GET /lots (AI)', request: { method: 'GET', url: '{{mes_url}}/lots', tags: ['erp'] } } },
  ];
  try {
    assert.ok(matchRequest(liveItem(list), { tokens: [{ kind: 'tag', value: 'cli' }] }));
    assert.ok(!matchRequest(list, { tokens: [{ kind: 'tag', value: 'cli' }] }), 'the saved request itself has no such tag yet');
    const tags = requestCatalog().tags.map((t) => t.value);
    assert.ok(tags.includes('cli') && tags.includes('erp'));
    assert.deepStrictEqual(global.HD.unsavedTabItems().map((x) => x.name), ['GET /lots (AI)']);
  } finally {
    delete ws.tabs;
  }
});

test('each typed word is found on its own, in any order, in the name, URL, tags, method or folders', () => {
  assert.deepStrictEqual(names({ tokens: [], text: 'order create' }), ['Create order'], 'words need not be next to each other');
  assert.deepStrictEqual(names({ tokens: [], text: 'post orders' }), ['Create order'], 'the method counts as text');
  assert.deepStrictEqual(names({ tokens: [], text: 'post' }), ['Create order', 'Take payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'text', value: 'smoke get' }] }), ['List orders'], 'a "Search for" chip works the same way');
  assert.deepStrictEqual(names({ tokens: [], text: 'create invoice' }), [], 'every word must be found');
  // Folder and collection names, given as the request's path.
  const inShop = (r, path) => matchRequest(r, { tokens: [], text: path }, { path: r === pay ? ['Shop'] : ['Shop', 'Orders'] });
  assert.ok(inShop(list, 'shop') && inShop(pay, 'shop'), 'the collection name finds all its requests');
  assert.ok(inShop(create, 'orders post') && !inShop(pay, 'orders post'));
  assert.ok(!matchRequest(pay, { tokens: [], text: 'shop' }), 'without a path, folder names are not searched');
});

test('with fuzzy, a word of 5 letters or more may be one typo away', () => {
  const { textFound } = global.HD;
  const fuzzy = (text) => [list, create, pay].filter((r) => matchRequest(r, { tokens: [], text }, { fuzzy: true })).map((r) => r.name);
  assert.deepStrictEqual(names({ tokens: [], text: 'ordrs' }), [], 'exact search ignores typos');
  assert.deepStrictEqual(fuzzy('ordrs'), ['List orders', 'Create order'], 'a missing letter');
  assert.deepStrictEqual(fuzzy('paymnet'), ['Take payment'], 'two letters swapped');
  assert.deepStrictEqual(fuzzy('creat0'), ['Create order'], 'a wrong letter');
  assert.deepStrictEqual(fuzzy('ordeers'), ['List orders', 'Create order'], 'an extra letter');
  assert.deepStrictEqual(fuzzy('pyment take'), ['Take payment'], 'a typo in one word, the rest exact');
  assert.deepStrictEqual(fuzzy('ordr'), [], 'short words must be exact');
  assert.deepStrictEqual(fuzzy('odrrs'), [], 'two typos are too many');
  assert.ok(textFound('custmer', ['Get customer'], true), 'a typo against a longer word');
  assert.ok(textFound('cutsom', ['customer-api'], true), 'a typo in the start of a longer word');
});
