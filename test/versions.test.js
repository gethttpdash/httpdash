'use strict';

// The window's request versions (versions.js) and their search (search.js), with a minimal HD.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = { collections: [], requestVersions: {} };
let n = 0;
global.HD = {
  h: () => ({}), S: { ws }, uid: () => `id${++n}`, clone: (o) => JSON.parse(JSON.stringify(o)), save: () => {},
  walk: (items, fn, parents = []) => { for (const it of items) { fn(it, parents); if (it.type === 'folder') global.HD.walk(it.items, fn, [...parents, it]); } },
};
for (const f of ['search.js', 'versions.js']) new Function(fs.readFileSync(path.join(__dirname, '../src/renderer/js', f), 'utf8'))();
const { recordVersion, versionsOf, versionKey, versionLabel, matchingVersions } = global.HD;

const def = (o = {}) => ({ method: 'POST', url: '{{pay_url}}/payments', params: [], headers: [{ key: 'X-Trace', value: '1', enabled: false }], body: { mode: 'raw', rawLanguage: 'json', raw: '{"amount":10}' }, auth: { type: 'inherit' }, testScript: 'x', ...o });
const ok = (status) => ({ response: { status, statusText: 'OK', time: 12, headers: [['Content-Type', 'application/json']], bodyText: `{"status":${status}}` }, tests: [] });

test('the same request sent again is one version; a different body is another', () => {
  const tab = { id: 't1', refId: 'r1', draft: { name: 'Pay', request: def() } };
  recordVersion(tab, def(), ok(201));
  recordVersion(tab, def({ testScript: 'changed', headers: [{ key: 'X-Trace', value: '2', enabled: false }] }), ok(200));
  let list = versionsOf('r1');
  assert.strictEqual(list.length, 1, 'scripts and disabled headers are not part of what was sent');
  assert.strictEqual(list[0].sends, 2);
  assert.strictEqual(list[0].response.status, 200, 'the latest response is kept');
  recordVersion(tab, def({ body: { mode: 'raw', rawLanguage: 'json', raw: '{"amount":25000}' } }), { error: 'connect ECONNREFUSED', tests: [] });
  list = versionsOf('r1');
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list[1].response, { error: 'connect ECONNREFUSED' });
  // Two unnamed versions of the same URL are told apart by their body.
  assert.deepStrictEqual(list.map((v) => versionLabel(v, list)), ['POST /payments · {"amount":10}', 'POST /payments · {"amount":25000}']);
  list[1].name = 'large payment';
  assert.strictEqual(versionLabel(list[1], list), 'large payment');
});

test('at most 50 per request, the named and tagged ones kept longest; an unsaved request\'s move when saved', () => {
  const tab = { id: 't2', refId: null, draft: { name: 'New' } };
  for (let i = 0; i < 55; i++) {
    const v = recordVersion(tab, def({ url: `{{pay_url}}/p/${i}` }), ok(200));
    v.lastSent = 1000 + i;
    if (i < 3) v.name = `keep ${i}`;
  }
  const list = versionsOf('tab:t2');
  assert.strictEqual(list.length, 50);
  assert.ok(['keep 0', 'keep 1', 'keep 2'].every((k) => list.some((v) => v.name === k)), 'named versions survive');
  tab.refId = 'r2';
  assert.strictEqual(versionKey(tab), 'r2');
  assert.strictEqual(versionsOf('r2').length, 50);
  assert.strictEqual(ws.requestVersions['tab:t2'], undefined);
});

test('named and tagged versions are found by search, with their request\'s tags', () => {
  const item = { id: 'r1', type: 'request', name: 'Take payment', request: { method: 'POST', url: '{{pay_url}}/payments', tags: ['payments'] } };
  ws.collections.push({ type: 'collection', name: 'Shop', items: [item] });
  const [small, large] = versionsOf('r1');
  large.tags = ['fraud'];
  const names = (query) => matchingVersions(item, query).map((v) => v.name || 'unnamed');
  assert.deepStrictEqual(names({ tokens: [], text: 'large' }), ['large payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'tag', value: 'fraud' }] }), ['large payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'tag', value: 'payments' }, { kind: 'tag', value: 'fraud' }] }), ['large payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'version', value: 'large' }] }), ['large payment']);
  assert.deepStrictEqual(names({ tokens: [{ kind: 'tag', value: 'payments' }] }), [], 'a match only through the request itself lists no version');
  assert.strictEqual(small.name, '', 'unnamed, untagged versions stay out of search');
  const c = global.HD.requestCatalog();
  assert.deepStrictEqual(c.versions.map((v) => v.value), ['large payment']);
  assert.ok(c.tags.some((t) => t.value === 'fraud'));
});
