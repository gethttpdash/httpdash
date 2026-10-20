'use strict';

/**
 * Spreads requests over a discovered service's instances and counts what each instance answered.
 *
 * The renderer sends the active environment's pools with a request's scopes:
 *   pools: { orders_url: { sourceId, service, strategy: 'first' | 'round-robin' | 'random', header,
 *                          default, instances: [{ id, url, healthy }] } }
 * `default` is the value discovery wrote into the environment. When a script, a data row or the
 * user has set the variable to something else, that value is used and no instance is picked.
 *
 * An instance is picked only when a request actually uses the variable, and once per request, so
 * the URL and a header that both use it go to the same instance. Round-robin positions live in this
 * module, so single sends, collection runs and monitors share one rotation.
 *
 * Each payload (see payloads.js) has its own rotation. With one shared rotation, payloads sent in
 * turn would move in step with the instances (3 payloads, 3 instances: the third payload always on
 * the third instance), and a slow payload could not be told from a slow instance.
 */

const positions = new Map(); // `${sourceId}|${variable}` -> next round-robin index

function pick(variable, pool, payload = '') {
  const all = (pool.instances || []).filter((i) => i && i.url);
  const healthy = all.filter((i) => i.healthy !== false);
  const list = healthy.length ? healthy : all;
  if (!list.length || pool.strategy === 'first' || !pool.strategy) {
    const own = all.find((i) => i.url === String(pool.default));
    return { id: own ? own.id || '' : '', url: String(pool.default) };
  }
  if (pool.strategy === 'random') return list[Math.floor(Math.random() * list.length)];
  const key = `${pool.sourceId}|${variable}|${payload}`;
  const n = positions.get(key) || 0;
  positions.set(key, n + 1);
  return list[n % list.length];
}

/**
 * Makes each pooled variable in `vars` (the merged scopes) pick its instance when it's first read.
 * `picks` (a Map) collects the choices for this request. Returns `vars`.
 */
function bind(vars, pools, picks, { payload = '' } = {}) {
  if (!pools) return vars;
  for (const [variable, pool] of Object.entries(pools)) {
    if (!Object.prototype.hasOwnProperty.call(vars, variable) || String(vars[variable]) !== String(pool.default)) continue;
    Object.defineProperty(vars, variable, {
      enumerable: true,
      configurable: true,
      get() {
        if (!picks.has(variable)) {
          const instance = pick(variable, pool, payload);
          picks.set(variable, { variable, sourceId: pool.sourceId, service: pool.service, instance: instance.url, instanceId: instance.id || '' });
        }
        return picks.get(variable).instance;
      },
    });
  }
  return vars;
}

const headerValue = (response, name) => {
  if (!name || !response) return '';
  const pair = (response.headers || []).find(([k]) => k.toLowerCase() === String(name).trim().toLowerCase());
  return pair ? String(pair[1]) : '';
};

// ---- Traffic by instance -------------------------------------------------------------------

const SAMPLES = 1000; // response times kept per instance, for percentiles

function add(rows, e) {
  const key = `${e.service}\u0000${e.instance}\u0000${e.servedBy}`;
  let r = rows.get(key);
  if (!r) {
    r = { service: e.service, variable: e.variable, instance: e.instance, instanceId: e.instanceId || '', servedBy: e.servedBy, requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, errors: 0, times: [], next: 0, last: 0 };
    rows.set(key, r);
  }
  r.requests++;
  if (e.error) r.errors++;
  else if (e.status >= 200 && e.status < 600) r.status[`${Math.floor(e.status / 100)}xx`]++;
  if (!e.error && e.time != null) {
    if (r.times.length < SAMPLES) r.times.push(e.time);
    else r.times[r.next++ % SAMPLES] = e.time;
  }
  r.last = e.at || Date.now();
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

function rowsOf(rows) {
  return [...rows.values()].map(({ times, next, ...r }) => {
    const sorted = [...times].sort((a, b) => a - b);
    return { ...r, p50: percentile(sorted, 50), p95: percentile(sorted, 95), avg: sorted.length ? Math.round(sorted.reduce((n, t) => n + t, 0) / sorted.length) : null };
  }).sort((a, b) => a.service.localeCompare(b.service) || b.requests - a.requests || a.instance.localeCompare(b.instance));
}

/** Per-instance totals for a list of routing entries (e.g. one collection run). */
function summarize(entries) {
  const rows = new Map();
  for (const e of entries) add(rows, e);
  return rowsOf(rows);
}

const stats = new Map(); // sourceId -> { since, rows: Map, byPayload: Map, recent: [] }
const RECENT = 200; // requests kept per source for the Recent requests list

function record(e) {
  if (!e.sourceId) return;
  if (!stats.has(e.sourceId)) stats.set(e.sourceId, { since: Date.now(), rows: new Map(), byPayload: new Map(), recent: [] });
  const s = stats.get(e.sourceId);
  add(s.rows, e);
  // The same totals by payload, to tell a slow payload from a slow instance.
  if (e.payload) add(s.byPayload, { ...e, instance: e.payload, instanceId: '', servedBy: '' });
  s.recent.push({
    sentAt: e.at - (e.time || 0), variable: e.variable, service: e.service, instance: e.instance, instanceId: e.instanceId || '',
    servedBy: e.servedBy, status: e.status, time: e.time, error: e.error, payload: e.payload || '',
  });
  if (s.recent.length > RECENT) s.recent.shift();
}

/**
 * Finishes a request's picks once it's answered (or failed): adds the status, the time and the
 * instance the response names in the pool's header, records them, and returns them.
 */
function settle(picks, pools, { response, error, payload } = {}) {
  const out = [];
  for (const p of picks.values()) {
    const pool = pools[p.variable] || {};
    const entry = {
      ...p, servedBy: headerValue(response, pool.header), at: Date.now(), payload: payload || '',
      status: response ? response.status : null, time: response ? response.time : null, error: error || null,
    };
    record(entry);
    out.push(entry);
  }
  return out;
}

/**
 * The traffic a source's instances have received since `since` (app start or the last reset), and
 * its latest requests, newest first, each with its gap: the milliseconds between the previous
 * request's response and this request being sent (0 when they overlapped).
 */
function metrics(sourceId) {
  const s = stats.get(sourceId);
  if (!s) return { since: Date.now(), rows: [], byPayload: [], recent: [] };
  const sorted = [...s.recent].sort((a, b) => a.sentAt - b.sentAt);
  const recent = sorted.map((r, i) => {
    const prev = sorted[i - 1];
    return { ...r, gap: prev ? Math.max(0, r.sentAt - (prev.sentAt + (prev.time || 0))) : null };
  }).reverse();
  const byPayload = rowsOf(s.byPayload).map(({ instance, instanceId, servedBy, ...r }) => ({ ...r, payload: instance }));
  return { since: s.since, rows: rowsOf(s.rows), byPayload, recent };
}

function reset(sourceId) {
  stats.delete(sourceId);
  for (const key of positions.keys()) if (key.startsWith(`${sourceId}|`)) positions.delete(key);
}

module.exports = { bind, settle, summarize, metrics, reset, pick };
