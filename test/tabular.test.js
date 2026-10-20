'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { flatten, toCsv, toXlsx, colName } = require('../src/core/tabular');

const records = [
  { id: 1, name: 'Ann, "the" first', paid: true, total: 12.5, address: { city: 'Lisbon', zip: '1000' }, tags: ['a', 'b'] },
  { id: 2, name: 'Bo\nChen', paid: false, total: null, address: { city: 'Osaka' }, note: '<b> & ok' },
];

test('records flatten into dotted columns', () => {
  const t = flatten(records);
  assert.deepStrictEqual(t.columns, ['id', 'name', 'paid', 'total', 'address.city', 'address.zip', 'tags', 'note']);
  assert.deepStrictEqual(t.rows[0], [1, 'Ann, "the" first', true, 12.5, 'Lisbon', '1000', '["a","b"]', null]);
  assert.deepStrictEqual(t.rows[1].slice(4, 6), ['Osaka', null]);
  assert.deepStrictEqual(flatten([1, 'x']), { columns: ['value'], rows: [[1], ['x']] });
});

test('CSV quotes commas, quotes and line breaks', () => {
  const csv = toCsv(flatten(records));
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'id,name,paid,total,address.city,address.zip,tags,note');
  assert.strictEqual(lines[1], '1,"Ann, ""the"" first",true,12.5,Lisbon,1000,"[""a"",""b""]",');
  assert.ok(csv.includes('2,"Bo\nChen",false,,Osaka,,,<b> & ok'));
});

// Reads a zip back with Node's own inflate, checking every entry's CRC.
function unzip(buf) {
  const files = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const dataStart = local + 30 + buf.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + size));
    assert.strictEqual(zlib.crc32(data) >>> 0, buf.readUInt32LE(p + 16), `crc of ${name}`);
    files[name] = data.toString();
    p += 46 + nameLen;
  }
  return files;
}

test('the Excel workbook is a valid zip with typed, escaped cells', () => {
  const files = unzip(toXlsx(flatten(records), { sheetName: 'Orders/2026' }));
  assert.deepStrictEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(files['xl/workbook.xml'], /<sheet name="Orders 2026"/);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t>id<\/t>/); // bold header
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c>/); // a number stays a number
  assert.match(sheet, /<c r="C2" t="b"><v>1<\/v><\/c>/); // booleans
  assert.match(sheet, /&lt;b&gt; &amp; ok/); // escaped
  assert.match(sheet, /<t xml:space="preserve">Bo\nChen<\/t>/);
  assert.match(sheet, /state="frozen"/);
  assert.ok(!/<c r="D3"/.test(sheet), 'nulls leave the cell empty');
});

test('column names run A..Z, AA..', () => {
  assert.deepStrictEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});
