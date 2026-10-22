'use strict';

// The renderer's reader for JSON cut short (a response version keeps its first 64 KB).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

global.HD = global.HD || {};
new Function(fs.readFileSync(path.join(__dirname, '../src/renderer/js/partial-json.js'), 'utf8'))();
const { parsePartialJson } = global.HD;

test('JSON cut short is closed at its last complete value', () => {
  const full = JSON.stringify({ statusCode: 200, data: { total: 3, items: [{ id: 1, name: 'a,b' }, { id: 2, name: 'say "hi" [x]' }, { id: 3, name: 'c' }] } });
  const cut = full.slice(0, full.indexOf('{"id":3') + 5);
  const p = parsePartialJson(cut);
  assert.strictEqual(p.partial, true);
  assert.deepStrictEqual(p.value.data.items, [{ id: 1, name: 'a,b' }, { id: 2, name: 'say "hi" [x]' }], 'commas, quotes and brackets inside strings are ignored');
  assert.strictEqual(p.value.statusCode, 200);
  assert.strictEqual(p.value.data.total, 3);
});

test('cut inside a string, right after a bracket, or at the start', () => {
  assert.deepStrictEqual(parsePartialJson('[{"a":1},{"a":"unfinis').value, [{ a: 1 }]);
  assert.deepStrictEqual(parsePartialJson('{"items":[').value, { items: [] });
  assert.deepStrictEqual(parsePartialJson('{"a":1,"b":').value, { a: 1 });
  assert.deepStrictEqual(parsePartialJson('{"a"').value, {}, 'nothing complete yet: an empty object');
  assert.deepStrictEqual(parsePartialJson('[[1,2],[3').value, [[1, 2]], 'an array item just begun is left out');
});

test('complete JSON and non-JSON are not treated as partial', () => {
  assert.strictEqual(parsePartialJson('{"a":1}'), undefined);
  assert.strictEqual(parsePartialJson('hello'), undefined);
});
