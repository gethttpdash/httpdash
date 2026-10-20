'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const report = require('../src/core/traffic-report');

// Header values come from servers: this one tries markup, a spreadsheet formula and a table break.
const evil = '<img src=x onerror=alert(1)>|=HYPERLINK("http://x")';
const sample = report.normalize({
  source: 'MES cluster', registry: 'Consul', strategy: 'each instance in turn (round robin)', header: 'X-Served-By', since: 0, generatedAt: Date.UTC(2026, 9, 21),
  totals: { requests: 30, instances: 2, slow: 1, failing: 1 },
  rows: [
    { service: 'orders', instanceId: 'orders-3', instance: 'http://10.0.0.3:7003', servedBy: '', requests: 18, share: 0.6, p50: 427, p95: 462, avg: 430, ok: 18, s4xx: 0, s5xx: 0, errors: 0, flags: ['slow'] },
    { service: 'orders', instanceId: '', instance: 'http://10.0.0.9:7000', servedBy: evil, requests: 12, share: 0.4, p50: 24, p95: 28, avg: 25, ok: 8, s4xx: 0, s5xx: 4, errors: 0, flags: ['failing'] },
  ],
  recent: [{ sentAt: Date.UTC(2026, 9, 21, 4, 43, 27, 17), gap: 54, service: 'orders', variable: 'orders_url', instance: 'http://10.0.0.3:7003', instanceId: 'orders-3', servedBy: '', status: 200, time: 427 }],
  injected: 'dropped',
});

test('normalize keeps only report fields, typed', () => {
  assert.strictEqual(sample.injected, undefined);
  const n = report.normalize({ rows: [{ requests: '5', share: 'x', flags: 'nope' }], totals: null });
  assert.deepStrictEqual([n.rows[0].requests, n.rows[0].share, n.rows[0].flags, n.totals.requests], [0, 0, [], 0]);
});

test('CSV: one row per instance, formulas defused', () => {
  const csv = report.toCsv(sample);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /^Service,Instance,Address,Answered as \(header\),Requests,Share,p50 ms/);
  assert.match(lines[1], /^orders,orders-3,http:\/\/10\.0\.0\.3:7003,,18,0\.6,427,462,430,18,0,0,0,slow$/);
  assert.ok(!/,=HYPERLINK/.test(csv) && !/,"=HYPERLINK/.test(csv), 'no cell starts with =');
});

test('Excel: two sheets, by instance and recent requests', () => {
  const buf = report.toXlsx(sample);
  const names = [];
  for (let p = 0; (p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p)) !== -1; p += 4) names.push(buf.subarray(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString());
  assert.ok(names.includes('xl/worksheets/sheet1.xml') && names.includes('xl/worksheets/sheet2.xml'));
  const wbAt = buf.indexOf(Buffer.from('xl/workbook.xml'));
  const local = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), wbAt);
  const size = buf.readUInt32LE(local + 18);
  const start = local + 30 + buf.readUInt16LE(local + 26);
  const wb = zlib.inflateRawSync(buf.subarray(start, start + size)).toString();
  assert.match(wb, /<sheet name="By instance"[^>]*\/><sheet name="Recent requests"/);
});

test('Markdown and HTML escape what servers sent', () => {
  const md = report.toMarkdown(sample);
  assert.match(md, /^# Traffic by instance: MES cluster/);
  assert.match(md, /\| orders \| orders-3 \(http:\/\/10\.0\.0\.3:7003\) \| 18 \| 60% \| 427 ms \| 462 ms \|/);
  const evilRow = md.split('\n').find((l) => l.includes('HYPERLINK'));
  assert.strictEqual(evilRow.split(/(?<!\\)\|/).length, 13, 'the pipe in the header value is escaped, so the row keeps its 11 columns');
  assert.ok(!md.includes('<img'));
  const html = report.toHtml(sample);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<span class="pill warn">slow<\/span>/);
});
