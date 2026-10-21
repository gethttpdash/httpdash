'use strict';

/**
 * The traffic report of a discovery source (requests per instance, and the latest requests) in the
 * formats it can be exported to: CSV, Excel, JSON, Markdown and a self-contained HTML page (which
 * is also printed to PDF and captured as a PNG image).
 *
 * report: {
 *   source, registry, strategy, header, since, generatedAt,
 *   totals: { requests, instances, slow, failing },
 *   rows: [{ service, instanceId, instance, servedBy, requests, share, p50, p95, avg, ok, s4xx, s5xx, errors, flags: ['slow' | 'failing' | 'left the pool'] }],
 *   byPayload: [{ service, payload, requests, share, p50, p95, avg, ok, s4xx, s5xx, errors, flags }],
 *   bySegment: [{ service, segment, requests, share, p50, p95, avg, ok, s4xx, s5xx, errors, flags }],
 *   recent: [{ sentAt, gap, service, variable, instance, instanceId, servedBy, payload, address, status, time, error }]
 * }
 * Instance names and header values come from servers, so every format escapes them.
 */
const tabular = require('./tabular');

const str = (v, max = 500) => (v == null ? '' : String(v).slice(0, max));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Keeps only the fields a report has, with the types it expects. */
function normalize(r) {
  const rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, 5000).map((x) => ({
    service: str(x.service), instanceId: str(x.instanceId), instance: str(x.instance), servedBy: str(x.servedBy),
    requests: num(x.requests) || 0, share: num(x.share) || 0, p50: num(x.p50), p95: num(x.p95), avg: num(x.avg),
    ok: num(x.ok) || 0, s4xx: num(x.s4xx) || 0, s5xx: num(x.s5xx) || 0, errors: num(x.errors) || 0,
    flags: (Array.isArray(x.flags) ? x.flags : []).map((f) => str(f, 40)),
  }));
  const recent = (Array.isArray(r.recent) ? r.recent : []).slice(0, 1000).map((x) => ({
    sentAt: num(x.sentAt), gap: num(x.gap), service: str(x.service), variable: str(x.variable), instance: str(x.instance),
    instanceId: str(x.instanceId), servedBy: str(x.servedBy), payload: str(x.payload, 200), address: str(x.address, 64), status: num(x.status), time: num(x.time), error: str(x.error),
  }));
  const byPayload = (Array.isArray(r.byPayload) ? r.byPayload : []).slice(0, 5000).map((x) => ({
    service: str(x.service), payload: str(x.payload, 200), requests: num(x.requests) || 0, share: num(x.share) || 0, p50: num(x.p50), p95: num(x.p95), avg: num(x.avg),
    ok: num(x.ok) || 0, s4xx: num(x.s4xx) || 0, s5xx: num(x.s5xx) || 0, errors: num(x.errors) || 0,
    flags: (Array.isArray(x.flags) ? x.flags : []).map((f) => str(f, 40)),
  }));
  const bySegment = (Array.isArray(r.bySegment) ? r.bySegment : []).slice(0, 5000).map((x) => ({
    service: str(x.service), segment: str(x.segment, 64), requests: num(x.requests) || 0, share: num(x.share) || 0, p50: num(x.p50), p95: num(x.p95), avg: num(x.avg),
    ok: num(x.ok) || 0, s4xx: num(x.s4xx) || 0, s5xx: num(x.s5xx) || 0, errors: num(x.errors) || 0,
    flags: (Array.isArray(x.flags) ? x.flags : []).map((f) => str(f, 40)),
  }));
  const t = r.totals || {};
  return {
    source: str(r.source, 200), registry: str(r.registry, 100), strategy: str(r.strategy, 100), header: str(r.header, 100),
    since: num(r.since), generatedAt: num(r.generatedAt) || Date.now(),
    totals: { requests: num(t.requests) || 0, instances: num(t.instances) || 0, slow: num(t.slow) || 0, failing: num(t.failing) || 0 },
    rows, byPayload, bySegment, recent,
  };
}

const name = (x) => x.servedBy || x.instanceId || x.instance;
const iso = (t) => (t == null ? '' : new Date(t).toISOString());
// Readable formats (Markdown, HTML, PDF, PNG) use the local time of the machine that made the
// report, with its offset; the data formats (CSV, Excel, JSON) keep ISO 8601 UTC.
const offset = (t) => {
  const m = -new Date(t).getTimezoneOffset();
  return `UTC${m < 0 ? '−' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${String(Math.abs(m) % 60).padStart(2, '0')}` : ''}`;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const localDateTime = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${offset(t)})`;
};
const localClock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const pct = (share) => `${Math.round(share * 100)}%`;

function tables(report) {
  const instances = {
    columns: ['Service', 'Instance', 'Address', 'Answered as (header)', 'Requests', 'Share', 'p50 ms', 'p95 ms', 'Average ms', 'OK (2xx/3xx)', '4xx', '5xx', 'Connection errors', 'Flags'],
    rows: report.rows.map((x) => [x.service, x.instanceId || x.servedBy || x.instance, x.instance, x.servedBy, x.requests, Math.round(x.share * 1000) / 1000, x.p50, x.p95, x.avg, x.ok, x.s4xx, x.s5xx, x.errors, x.flags.join(', ')]),
  };
  const recent = {
    columns: ['Sent', 'Gap ms', 'Service', 'Variable', 'Instance', 'Address', 'Answered as (header)', 'Payload', 'IP address', 'Status', 'Time ms', 'Error'],
    rows: report.recent.map((x) => [iso(x.sentAt), x.gap, x.service, x.variable, x.instanceId || x.instance, x.instance, x.servedBy, x.payload, x.address, x.status, x.time, x.error]),
  };
  const payloads = {
    columns: ['Service', 'Payload', 'Requests', 'Share', 'p50 ms', 'p95 ms', 'Average ms', 'OK (2xx/3xx)', '4xx', '5xx', 'Connection errors', 'Flags'],
    rows: report.byPayload.map((x) => [x.service, x.payload, x.requests, Math.round(x.share * 1000) / 1000, x.p50, x.p95, x.avg, x.ok, x.s4xx, x.s5xx, x.errors, x.flags.join(', ')]),
  };
  const segments = {
    columns: ['Service', 'Network segment', 'Requests', 'Share', 'p50 ms', 'p95 ms', 'Average ms', 'OK (2xx/3xx)', '4xx', '5xx', 'Connection errors', 'Flags'],
    rows: report.bySegment.map((x) => [x.service, x.segment, x.requests, Math.round(x.share * 1000) / 1000, x.p50, x.p95, x.avg, x.ok, x.s4xx, x.s5xx, x.errors, x.flags.join(', ')]),
  };
  return { instances, recent, payloads, segments };
}

// A spreadsheet treats a cell starting with = + - @ as a formula; a server-chosen header value must stay text.
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const safeTable = (t) => ({ columns: t.columns, rows: t.rows.map((r) => r.map(safeCell)) });

const toCsv = (report) => `﻿${tabular.toCsv(safeTable(tables(report).instances))}`;

function toXlsx(report) {
  const t = tables(report);
  return tabular.toXlsxBook([
    { name: 'By instance', table: safeTable(t.instances) },
    ...(report.byPayload.length ? [{ name: 'By payload', table: safeTable(t.payloads) }] : []),
    ...(report.bySegment.length ? [{ name: 'By network segment', table: safeTable(t.segments) }] : []),
    { name: 'Recent requests', table: safeTable(t.recent) },
  ]);
}

const toJson = (report) => JSON.stringify(report, null, 2);

const meta = (report) => [
  report.registry && `Registry: ${report.registry}`,
  report.strategy && `Sending to: ${report.strategy}`,
  report.header && `Counted by header: ${report.header}`,
  report.since && `Since: ${localDateTime(report.since)}`,
  `Generated: ${localDateTime(report.generatedAt)}`,
].filter(Boolean);

function toMarkdown(report) {
  // Markdown punctuation escaped, and < > as entities, so no renderer turns a server's value into markup.
  const md = (s) => String(s == null ? '' : s).replace(/([\\|`*_[\]#])/g, '\\$1').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ');
  const ms = (v) => (v == null ? '—' : `${v} ms`);
  const t = report.totals;
  const lines = [
    `# Traffic by instance: ${md(report.source)}`, '',
    ...meta(report).map((m) => `- ${md(m)}`), '',
    `**${t.requests}** requests · **${t.instances}** instances answering · **${t.slow}** slow · **${t.failing}** failing`, '',
    '| Service | Instance | Requests | Share | p50 | p95 | OK | 4xx | 5xx | Errors | Flags |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...report.rows.map((x) => `| ${md(x.service)} | ${md(name(x))}${x.instanceId || x.servedBy ? ` (${md(x.instance)})` : ''} | ${x.requests} | ${pct(x.share)} | ${ms(x.p50)} | ${ms(x.p95)} | ${x.ok} | ${x.s4xx} | ${x.s5xx} | ${x.errors} | ${md(x.flags.join(', '))} |`),
  ];
  if (report.byPayload.length) {
    lines.push('', '## By payload', '', '| Service | Payload | Requests | Share | p50 | p95 | OK | 4xx | 5xx | Errors | Flags |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...report.byPayload.map((x) => `| ${md(x.service)} | ${md(x.payload)} | ${x.requests} | ${pct(x.share)} | ${ms(x.p50)} | ${ms(x.p95)} | ${x.ok} | ${x.s4xx} | ${x.s5xx} | ${x.errors} | ${md(x.flags.join(', '))} |`));
  }
  if (report.bySegment.length) {
    lines.push('', '## By network segment', '', '| Service | Segment | Requests | Share | p50 | p95 | OK | 4xx | 5xx | Errors | Flags |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...report.bySegment.map((x) => `| ${md(x.service)} | ${md(x.segment)} | ${x.requests} | ${pct(x.share)} | ${ms(x.p50)} | ${ms(x.p95)} | ${x.ok} | ${x.s4xx} | ${x.s5xx} | ${x.errors} | ${md(x.flags.join(', '))} |`));
  }
  if (report.recent.length) {
    lines.push('', `## Recent requests (latest ${Math.min(50, report.recent.length)})`, '',
      `| Sent (${offset(report.generatedAt)}) | Gap | Instance | Payload | Status | Time |`, '| --- | ---: | --- | --- | --- | ---: |',
      ...report.recent.slice(0, 50).map((x) => `| ${x.sentAt == null ? '' : localClock(x.sentAt)} | ${x.gap == null ? '—' : `+${Math.round(x.gap)} ms`} | ${md(name(x))} | ${md(x.payload) || '—'} | ${x.error ? md(x.error) : x.status} | ${ms(x.time)} |`));
  }
  return `${lines.join('\n')}\n`;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A self-contained page (no scripts, no external files), light, sized for a report or a slide. */
function toHtml(report) {
  const t = report.totals;
  const ms = (v) => (v == null ? '—' : `${v} ms`);
  const flag = (f) => `<span class="pill ${f === 'slow' ? 'warn' : f === 'failing' ? 'err' : 'muted'}">${esc(f)}</span>`;
  const services = [...new Set(report.rows.map((x) => x.service))];
  const body = services.map((svc) => {
    const list = report.rows.filter((x) => x.service === svc);
    const total = list.reduce((n, x) => n + x.requests, 0);
    return `<tr class="svc"><td colspan="9"><b>${esc(svc)}</b> · ${total} request${total === 1 ? '' : 's'}</td></tr>${list.map((x) => `<tr>
      <td><div class="name">${esc(name(x))} ${x.flags.map(flag).join(' ')}</div><div class="addr">${x.servedBy ? `answered via ${esc(x.instance)}` : x.instanceId ? esc(x.instance) : ''}</div></td>
      <td class="n">${x.requests}</td>
      <td><div class="share"><div class="bar"><span style="width:${Math.round(x.share * 100)}%"></span></div>${pct(x.share)}</div></td>
      <td class="n">${ms(x.p50)}</td><td class="n">${ms(x.p95)}</td><td class="n">${x.ok}</td>
      <td class="n${x.s4xx ? ' warn' : ''}">${x.s4xx}</td><td class="n${x.s5xx ? ' err' : ''}">${x.s5xx}</td><td class="n${x.errors ? ' err' : ''}">${x.errors}</td></tr>`).join('')}`;
  }).join('');
  const payloadRows = report.byPayload.map((x) => `<tr><td>${esc(x.service)}</td><td><b>${esc(x.payload)}</b> ${x.flags.map(flag).join(' ')}</td><td class="n">${x.requests}</td>
    <td class="n">${ms(x.p50)}</td><td class="n">${ms(x.p95)}</td><td class="n">${x.ok}</td><td class="n${x.s4xx ? ' warn' : ''}">${x.s4xx}</td><td class="n${x.s5xx ? ' err' : ''}">${x.s5xx}</td><td class="n${x.errors ? ' err' : ''}">${x.errors}</td></tr>`).join('');
  const segmentRows = report.bySegment.map((x) => `<tr><td>${esc(x.service)}</td><td class="mono"><b>${esc(x.segment)}</b> ${x.flags.map(flag).join(' ')}</td><td class="n">${x.requests}</td>
    <td class="n">${ms(x.p50)}</td><td class="n">${ms(x.p95)}</td><td class="n">${x.ok}</td><td class="n${x.s4xx ? ' warn' : ''}">${x.s4xx}</td><td class="n${x.s5xx ? ' err' : ''}">${x.s5xx}</td><td class="n${x.errors ? ' err' : ''}">${x.errors}</td></tr>`).join('');
  const withPayload = report.recent.some((x) => x.payload);
  const recent = report.recent.slice(0, 25).map((x) => `<tr><td class="mono">${x.sentAt == null ? '' : localClock(x.sentAt)}</td><td class="n">${x.gap == null ? '—' : `+${Math.round(x.gap)} ms`}</td>
    <td>${esc(name(x))}</td>${withPayload ? `<td>${esc(x.payload) || '—'}</td>` : ''}<td class="${x.error || x.status >= 500 ? 'err' : x.status >= 400 ? 'warn' : 'ok'}">${x.error ? esc(x.error) : x.status}</td><td class="n">${ms(x.time)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Traffic by instance: ${esc(report.source)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 36px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1d2027; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 28px 0 8px; }
  .meta { color: #5c626e; margin-bottom: 18px; } .meta span + span::before { content: " · "; }
  .cards { display: flex; gap: 12px; margin-bottom: 18px; }
  .card { border: 1px solid #e3e5e9; border-radius: 8px; padding: 10px 16px; min-width: 120px; }
  .card b { display: block; font-size: 22px; } .card span { color: #5c626e; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .card.warn b { color: #a34b08; } .card.err b { color: #c42020; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #5c626e; padding: 8px; border-bottom: 1px solid #e3e5e9; background: #f7f7f8; }
  td { padding: 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  th.n, td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr.svc td { background: #f7f7f8; }
  .name { font-weight: 600; } .addr, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #5c626e; }
  .share { display: flex; align-items: center; gap: 8px; } .bar { width: 120px; height: 6px; background: #e3e5e9; border-radius: 3px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: #c2410c; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 99px; margin-left: 4px; }
  .pill.warn { background: #fff6e0; color: #a34b08; } .pill.err { background: #fdecec; color: #c42020; } .pill.muted { background: #eceef1; color: #5c626e; }
  .warn { color: #a34b08; } .err { color: #c42020; } .ok { color: #107435; }
  footer { margin-top: 24px; color: #8a8f99; font-size: 11px; }
  @page { margin: 14mm; }
</style></head><body>
<h1>Traffic by instance: ${esc(report.source)}</h1>
<div class="meta">${meta(report).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
<div class="cards">
  <div class="card"><b>${t.requests}</b><span>Requests</span></div>
  <div class="card"><b>${t.instances}</b><span>Instances answering</span></div>
  <div class="card${t.slow ? ' warn' : ''}"><b>${t.slow}</b><span>Slow</span></div>
  <div class="card${t.failing ? ' err' : ''}"><b>${t.failing}</b><span>Failing</span></div>
</div>
<table><thead><tr><th>Instance</th><th class="n">Requests</th><th>Share</th><th class="n">p50</th><th class="n">p95</th><th class="n">OK</th><th class="n">4xx</th><th class="n">5xx</th><th class="n">Errors</th></tr></thead>
<tbody>${body || '<tr><td colspan="9">No requests yet.</td></tr>'}</tbody></table>
${payloadRows ? `<h2>By payload</h2><table><thead><tr><th>Service</th><th>Payload</th><th class="n">Requests</th><th class="n">p50</th><th class="n">p95</th><th class="n">OK</th><th class="n">4xx</th><th class="n">5xx</th><th class="n">Errors</th></tr></thead><tbody>${payloadRows}</tbody></table>` : ''}
${segmentRows ? `<h2>By network segment</h2><table><thead><tr><th>Service</th><th>Segment</th><th class="n">Requests</th><th class="n">p50</th><th class="n">p95</th><th class="n">OK</th><th class="n">4xx</th><th class="n">5xx</th><th class="n">Errors</th></tr></thead><tbody>${segmentRows}</tbody></table>` : ''}
${recent ? `<h2>Recent requests</h2><table><thead><tr><th>Sent (${offset(report.generatedAt)})</th><th class="n">Gap</th><th>Instance</th>${withPayload ? '<th>Payload</th>' : ''}<th>Status</th><th class="n">Time</th></tr></thead><tbody>${recent}</tbody></table>` : ''}
<footer>HttpDash · times are measured from the machine that sent the requests</footer>
</body></html>`;
}

module.exports = { normalize, tables, toCsv, toXlsx, toJson, toMarkdown, toHtml };
