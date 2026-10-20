'use strict';

/**
 * Compares the answers several instances of a service gave to the same request.
 *
 * Every answer is reduced to keys: the status (or the error), each header, and each leaf of a JSON
 * body by path ("items[3].qty"; a text body is one key). For each key the instances either agree
 * or they don't, and a disagreement is one of:
 *   odd     most instances agree and a few don't: the few are the odd ones out (a stale pod, an
 *           old version, a different config). "Most" is a majority, or a value shared by at least
 *           two instances while every other one stands alone (2 x 200, one 503, one down).
 *   split   nothing stands out (two instances, or two against two)
 *   varies  every instance has its own value: ids, timestamps, the instance's own name, and so
 *           usually expected. Values made at the moment of answering (timestamps within minutes of
 *           now) and UUIDs count as varying whenever they differ: two instances answering in the
 *           same millisecond must not make the third look like the odd one out.
 * Headers that always differ between answers (Date, request ids...) are ignored, and so are the
 * header names and body paths the user chose to ignore. A path may use [*] for any array index.
 */

const IGNORED_HEADERS = new Set([
  'date', 'age', 'expires', 'last-modified', 'etag', 'set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'x-request-id', 'x-correlation-id', 'x-trace-id', 'traceparent', 'tracestate', 'x-amzn-trace-id', 'x-b3-traceid', 'x-b3-spanid',
  'x-served-by', 'x-instance-id', 'x-backend', 'x-upstream', 'server-timing', 'x-response-time', 'x-runtime', 'cf-ray', 'via',
]);
const MAX_LEAVES = 20000;

// Flattens JSON into path -> value. Objects and arrays that are empty are leaves themselves.
function flatten(value, path, out) {
  if (out.size >= MAX_LEAVES) return out;
  if (Array.isArray(value)) {
    out.set(`${path}.length`, value.length);
    if (!value.length) out.set(path, '[]');
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out.set(path, '{}');
    for (const k of keys) flatten(value[k], path ? `${path}.${k}` : k, out);
  } else out.set(path || '(root)', value);
  return out;
}

// "items[*].updatedAt" matches items[0].updatedAt...; a pattern also covers everything below it.
function matcher(patterns) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = (patterns || []).map((p) => String(p).trim()).filter(Boolean)
    .map((p) => new RegExp(`^${p.split('[*]').map(esc).join('\\[\\d+\\]')}(?:$|[.\\[])`));
  return (path) => res.some((r) => r.test(path));
}

// A value made at the moment of answering: a timestamp close to now (ISO text, or epoch ms / s), or a UUID.
const RECENT_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function madeNow(v, now) {
  if (typeof v === 'string') {
    if (UUID.test(v)) return true;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return false;
    const t = Date.parse(v);
    return Number.isFinite(t) && Math.abs(t - now) < RECENT_MS;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v - now) < RECENT_MS || Math.abs(v * 1000 - now) < RECENT_MS;
  return false;
}

const show = (v) => (v === undefined ? '(missing)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/**
 * results: [{ instance, instanceId, response: { status, headers: [[k, v]], bodyText, time } | null, error, tests: [{ passed }] }]
 * opts: { ignoreHeaders: [names], ignorePaths: [patterns] }
 * Returns { instances, differences, baseline } (see the file comment).
 */
function compare(results, { ignoreHeaders = [], ignorePaths = [] } = {}) {
  const extraHeaders = new Set(ignoreHeaders.map((h) => String(h).toLowerCase()));
  const ignoredPath = matcher(ignorePaths);
  const keyed = results.map((r) => {
    const keys = new Map();
    if (r.error || !r.response) { keys.set('error', r.error || 'no response'); return keys; }
    const res = r.response;
    keys.set('status', res.status);
    const seen = new Map();
    for (const [k, v] of res.headers || []) {
      const name = String(k).toLowerCase();
      if (IGNORED_HEADERS.has(name) || extraHeaders.has(name)) continue;
      seen.set(name, seen.has(name) ? `${seen.get(name)}, ${v}` : String(v));
    }
    for (const [name, v] of seen) keys.set(`header:${name}`, v);
    let json;
    try { json = JSON.parse(res.bodyText); } catch { json = undefined; }
    if (json !== undefined && res.bodyText && res.bodyText.trim()) {
      for (const [path, v] of flatten(json, '', new Map())) if (!ignoredPath(path)) keys.set(`body:${path}`, v);
    } else keys.set('body', res.bodyText || '');
    return keys;
  });

  const allKeys = [...new Set(keyed.flatMap((k) => [...k.keys()]))];
  const n = results.length;
  const now = Date.now();
  const differences = [];
  for (const key of allKeys) {
    const values = keyed.map((k) => (k.has(key) ? k.get(key) : undefined));
    const shown = values.map(show);
    const counts = new Map();
    for (const s of shown) counts.set(s, (counts.get(s) || 0) + 1);
    if (counts.size === 1) continue;
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const [top, topCount] = ranked[0];
    const next = ranked[1][1];
    let kind;
    if (n >= 3 && values.every((v) => v === undefined || madeNow(v, now))) kind = 'varies';
    else if (n >= 3 && topCount >= 2 && topCount > next && (topCount > n / 2 || next === 1)) kind = 'odd';
    else if (n >= 3 && counts.size === n) kind = 'varies';
    else kind = 'split';
    differences.push({
      key,
      kind,
      majority: kind === 'odd' ? top : null,
      values: results.map((r, i) => ({ instance: r.instance, instanceId: r.instanceId || '', value: shown[i] })),
      odd: kind === 'odd' ? results.filter((r, i) => shown[i] !== top).map((r) => r.instance) : [],
    });
  }
  // Status and errors first, then headers, then the body in path order.
  const rank = (d) => (d.key === 'error' ? 0 : d.key === 'status' ? 1 : d.key.startsWith('header:') ? 2 : 3);
  differences.sort((a, b) => rank(a) - rank(b) || (a.kind === 'varies') - (b.kind === 'varies') || a.key.localeCompare(b.key, undefined, { numeric: true }));

  const instances = results.map((r) => {
    const tests = r.tests || [];
    const oddIn = differences.filter((d) => d.odd.includes(r.instance)).length;
    return {
      instance: r.instance, instanceId: r.instanceId || '', status: r.response ? r.response.status : null, time: r.response ? r.response.time : null,
      error: r.error || null, tests: { passed: tests.filter((t) => t.passed && !t.skipped).length, failed: tests.filter((t) => !t.passed).length },
      odd: oddIn,
    };
  });
  // The answer to show as the main response: one from an instance that is never the odd one out.
  const baseline = Math.max(0, instances.findIndex((x) => !x.odd && !x.error));
  return { instances, differences, baseline };
}

module.exports = { compare, flatten, matcher, IGNORED_HEADERS };
