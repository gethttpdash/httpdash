'use strict';

/**
 * Health profiling: read a service's health endpoint before, during and after a request, to see
 * what the server went through while it answered (connections held, queues, memory, a database
 * that went down).
 *
 * Config (on a request definition, folder or collection, as `health`):
 * {
 *   mode: 'inherit' | 'none' | 'enabled',
 *   url: '/healthz',          // a path is read on the request's own host (and instance);
 *                             // a full URL ('{{mes_url}}/healthz') is read as written
 *   intervalMs: 250,          // how often to read it while the request is in flight
 *   sendAuth: false,          // send the request's Authorization header with it
 *   watch: ['db.transactions'], // optional: only these fields (and what is under them)
 * }
 *
 * The result has every sample (phase, time relative to when the request was sent, status, how
 * long the health endpoint took, whether it said it was healthy) and, per field, its value before
 * and after and its range during the request, with the fields that moved listed first.
 */
const httpClient = require('./http-client');
const { resolve } = require('./variables');
const { flatten } = require('./compare');

const DEFAULT_INTERVAL = 250;
const MIN_INTERVAL = 50;
const MAX_SAMPLES = 200;
const MAX_FIELDS = 400;
const MAX_BODY = 512 * 1024;
const TIMEOUT = 5000;

// The health config that applies: request -> nearest folder -> collection.
function effectiveHealth(request, chain) {
  const nodes = [...(chain || [])];
  const ok = (c) => (c && c.mode === 'enabled' && String(c.url || '').trim() ? c : null);
  const own = request && request.health;
  if (own && own.mode && own.mode !== 'inherit') return ok(own);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const c = nodes[i] && nodes[i].health;
    if (c && c.mode && c.mode !== 'inherit') return ok(c);
  }
  return null;
}

// The health URL for a request: a path goes to the request's own origin.
function healthUrl(cfg, vars, requestUrl) {
  const raw = resolve(String(cfg.url || '').trim(), vars || {});
  if (raw.startsWith('/') && requestUrl) {
    try { return new URL(raw, requestUrl).toString(); } catch { return raw; }
  }
  return raw;
}

const intervalOf = (cfg) => Math.max(MIN_INTERVAL, Number(cfg.intervalMs) || DEFAULT_INTERVAL);

// Whether a health answer says it is healthy: its status, then `ok` or `status` in its body
// (OpenCore MES { ok }, Spring Boot { status: "UP" }, the IETF draft { status: "pass" }).
function judge(status, json) {
  if (status >= 400) return false;
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    if (typeof json.ok === 'boolean') return json.ok;
    if (typeof json.healthy === 'boolean') return json.healthy;
    if (typeof json.status === 'string') return /^(up|ok|pass|healthy|green|ready)$/i.test(json.status);
  }
  return true;
}

const watched = (watch) => {
  const list = (Array.isArray(watch) ? watch : String(watch || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return () => true;
  return (path) => list.some((w) => path === w || path.startsWith(`${w}.`) || path.startsWith(`${w}[`));
};

// The leaves of a health body: { "db.state": "up", "db.transactions.waiting": 0, ... }.
function fieldsOf(json, keep) {
  const out = {};
  if (json === undefined || json === null || typeof json !== 'object') return out;
  let n = 0;
  for (const [path, v] of flatten(json, '', new Map())) {
    if (!keep(path)) continue;
    if (v !== null && typeof v === 'object') continue;
    out[path] = v;
    if (++n >= MAX_FIELDS) break;
  }
  return out;
}

/**
 * Reads the health endpoint once. base: the client options the request was sent with (TLS,
 * certificates, proxy), so the health check reaches the server the same way.
 */
async function read({ url, base = {}, headers = [], connectTo, keep = () => true }) {
  const started = Date.now();
  try {
    const raw = await httpClient.send({
      ...base,
      method: 'GET',
      url,
      headers: [['Accept', 'application/json'], ...headers],
      body: null,
      timeout: TIMEOUT,
      followRedirects: true,
      signal: undefined,
      onData: undefined,
      ...(connectTo ? { connectTo } : {}),
    });
    const ms = Date.now() - started;
    let json;
    if (raw.body && raw.body.length <= MAX_BODY) {
      try { json = JSON.parse(raw.body.toString('utf8')); } catch { json = undefined; }
    }
    return { status: raw.status, ms, ok: judge(raw.status, json), values: fieldsOf(json, keep) };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, ok: false, error: e.message || String(e), values: {} };
  }
}

/**
 * Samples the health endpoint around one request (during it: one reading as it is sent, then one
 * every interval until it answers):
 *   const p = profiler(cfg, { url, base, headers, connectTo });
 *   await p.before(); p.start(); ...send...; p.end(); await p.after(); result.health = p.result();
 * Reads while the request is in flight never overlap: the next one starts after the last answers.
 */
function profiler(cfg, { url, base, headers, connectTo, readHealth = read }) {
  const keep = watched(cfg.watch);
  const interval = intervalOf(cfg);
  const samples = [];
  let sentAt = 0;
  let endedAt = 0;
  let timer = null;
  let busy = null;
  let running = false;

  const take = async (phase) => {
    if (samples.length >= MAX_SAMPLES) return;
    const at = Date.now();
    const s = await readHealth({ url, base, headers, connectTo, keep });
    samples.push({ phase, t: sentAt ? at - sentAt : 0, ...s });
  };
  const tick = () => {
    if (!running) return;
    busy = take('during').finally(() => {
      busy = null;
      if (running) timer = setTimeout(tick, interval);
    });
  };

  return {
    async before() { await take('before'); },
    start() {
      sentAt = Date.now();
      for (const s of samples) if (s.phase === 'before') s.t = -s.ms;
      running = true;
      tick(); // the first reading as the request goes out, so a fast request has one too
    },
    async end() {
      endedAt = Date.now();
      running = false;
      clearTimeout(timer);
      if (busy) await busy;
    },
    async after() {
      if (!endedAt) await this.end();
      await take('after');
    },
    result() { return summarize({ url, intervalMs: interval, requestMs: endedAt && sentAt ? endedAt - sentAt : null, samples }); },
  };
}

const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/**
 * { url, intervalMs, requestMs, samples, ok, unhealthy, slowest, fields: [{ path, before, after,
 *   min, max, numeric, changed }] } — fields that moved first. Samples keep only those fields.
 */
function summarize({ url, intervalMs, requestMs, samples }) {
  const paths = new Set();
  for (const s of samples) for (const k of Object.keys(s.values || {})) paths.add(k);
  const fields = [];
  for (const path of paths) {
    const seen = samples.filter((s) => s.values && Object.prototype.hasOwnProperty.call(s.values, path)).map((s) => s.values[path]);
    const first = samples.find((s) => s.phase === 'before' && s.values && path in s.values);
    const last = [...samples].reverse().find((s) => s.phase === 'after' && s.values && path in s.values);
    const numeric = seen.length > 0 && seen.every((v) => typeof v === 'number');
    const changed = seen.some((v) => !same(v, seen[0])) || seen.length < samples.filter((s) => !s.error).length;
    const f = { path, before: first ? first.values[path] : undefined, after: last ? last.values[path] : undefined, numeric, changed };
    if (numeric) { f.min = Math.min(...seen); f.max = Math.max(...seen); }
    fields.push(f);
  }
  fields.sort((a, b) => (b.changed - a.changed) || a.path.localeCompare(b.path));
  const moved = new Set(fields.filter((f) => f.changed).map((f) => f.path));
  const kept = samples.map((s) => ({ ...s, values: Object.fromEntries(Object.entries(s.values || {}).filter(([k]) => moved.has(k))) }));
  const answered = samples.filter((s) => !s.error);
  return {
    url,
    intervalMs,
    requestMs,
    samples: kept,
    ok: samples.length > 0 && samples.every((s) => s.ok),
    unhealthy: samples.filter((s) => !s.ok).length,
    slowest: answered.length ? Math.max(...answered.map((s) => s.ms)) : null,
    fields,
  };
}

// A few words about a health result, for the runner and the CLI: "db.transactions.waiting 0 → 3 → 0".
function describe(h, limit = 3) {
  if (!h) return '';
  const moved = h.fields.filter((f) => f.changed).slice(0, limit).map((f) => {
    if (f.numeric) {
      const peak = Math.abs(f.max - (f.before ?? f.max)) >= Math.abs(f.min - (f.before ?? f.min)) ? f.max : f.min;
      return `${f.path} ${fmt(f.before)} → ${fmt(peak)} → ${fmt(f.after)}`;
    }
    return `${f.path} ${fmt(f.before)} → ${fmt(f.after)}`;
  });
  const state = h.ok ? 'healthy throughout' : `${h.unhealthy} of ${h.samples.length} readings unhealthy`;
  return [state, ...moved].join('; ');
}

const fmt = (v) => (v === undefined ? '–' : typeof v === 'string' ? v : JSON.stringify(v));

module.exports = { effectiveHealth, healthUrl, judge, fieldsOf, read, profiler, summarize, describe, DEFAULT_INTERVAL };
