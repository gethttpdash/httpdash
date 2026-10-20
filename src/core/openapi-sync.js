'use strict';

/**
 * Keeps a collection in step with an OpenAPI document (the "OpenAPI document" discovery source).
 *
 * Each sync records the document's version (info.version) and a fingerprint of its content, so an
 * unchanged spec is recognised and a changed one is reported before anything is written. Every
 * generated request remembers its operation ("GET /orders/{id}") and fingerprints of what the spec
 * gave it last time. Comparing those with the new spec says what the spec changed; comparing them
 * with the request says what the user changed. Fields the user hasn't touched follow the spec,
 * edited ones are kept (and reported), values typed into params and headers are kept, and scripts,
 * tests and requests the user added are never touched. A request whose operation left the spec is
 * removed, unless the user changed it; then it stays as an ordinary request.
 */
const crypto = require('crypto');
const { importOpenApi } = require('./postman');

// Same text as the request editor writes, so a synced URL looks like one typed in.
const splitUrl = (url) => {
  const s = String(url || '');
  const hashIdx = s.indexOf('#');
  const noHash = hashIdx === -1 ? s : s.slice(0, hashIdx);
  const q = noHash.indexOf('?');
  return { base: q === -1 ? noHash : noHash.slice(0, q), hash: hashIdx === -1 ? '' : s.slice(hashIdx) };
};
const buildQuery = (params) => params.filter((p) => p.enabled !== false && (p.key || p.value)).map((p) => (p.value === '' || p.value == null ? p.key : `${p.key}=${p.value}`)).join('&');
const withQuery = (base, params, hash = '') => {
  const qs = buildQuery(params);
  return `${base}${qs ? `?${qs}` : ''}${hash}`;
};

// A fingerprint that doesn't depend on key order, so an editor rewriting an object the same way doesn't count as an edit.
const canon = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const fingerprint = (v, length = 12) => crypto.createHash('sha256').update(canon(v)).digest('base64url').slice(0, length);

/** What identifies a version of the spec: its declared version and a fingerprint of its content. */
const specInfo = (doc) => ({
  title: (doc.info && doc.info.title) || '',
  version: doc.info && doc.info.version != null ? String(doc.info.version) : '',
  format: doc.openapi ? `OpenAPI ${doc.openapi}` : doc.swagger ? `Swagger ${doc.swagger}` : '',
  hash: fingerprint(doc, 16),
});

const row = (r) => [r.value == null ? '' : r.value, r.enabled !== false, r.type || 'text'];
const ROWS = { params: 'query param', pathVariables: 'path variable', headers: 'header' };

// The parts of a request that follow the spec as a whole, each reduced to what matters.
const FIELDS = {
  name: (item) => item.name,
  description: (item) => item.request.description || '',
  path: (item) => splitUrl(item.request.url).base,
  body: (item) => {
    const b = item.request.body || {};
    const mode = b.mode || 'none';
    if (mode === 'raw') return [mode, b.raw || '', b.rawLanguage || ''];
    if (mode === 'urlencoded' || mode === 'formdata') return [mode, (b[mode] || []).filter((r) => r.key).map((r) => [r.key, ...row(r)])];
    return [mode, mode === 'none' ? null : b[mode]];
  },
  auth: (item) => {
    const a = item.request.auth || { type: 'inherit' };
    return [a.type, a[a.type] || null];
  },
};
const FIELD_LABEL = { name: 'name', description: 'description', path: 'URL', body: 'body', auth: 'auth' };
const examplesOf = (item) => (item.examples || []).map((e) => [e.name, e.status, e.headers, e.body]);

// Each row's fingerprint by key (the first row of a key, if a key repeats).
const rowPrints = (list) => {
  const out = {};
  for (const r of list || []) if (r.key && !(r.key in out)) out[r.key] = fingerprint(row(r));
  return out;
};

function snapshot(gen) {
  const base = {};
  for (const [field, of] of Object.entries(FIELDS)) base[field] = fingerprint(of(gen));
  base.examples = fingerprint(examplesOf(gen));
  const rows = {};
  for (const list of Object.keys(ROWS)) rows[list] = rowPrints(gen.request[list]);
  return { op: gen.openapi.op, base, rows };
}

/** True when the user changed a synced request since the spec last wrote it. */
function edited(item) {
  const last = item.openapi || {};
  const base = last.base || {};
  if (item.request.preRequestScript || item.request.testScript) return true;
  if (Object.entries(FIELDS).some(([field, of]) => fingerprint(of(item)) !== base[field])) return true;
  return Object.keys(ROWS).some((list) => {
    const was = (last.rows && last.rows[list]) || {};
    const now = rowPrints(item.request[list]);
    return Object.keys(was).length !== Object.keys(now).length || Object.entries(now).some(([k, fp]) => was[k] !== fp);
  });
}

/**
 * Merges a key/value list. Rows come in the spec's order; a row the user hasn't changed takes the
 * spec's (new example or default), a row the user changed keeps its value and on/off state; rows the
 * user added stay; rows the spec dropped go. Returns the merged rows and what the spec changed.
 */
function mergeRows(current, generated, lastPrints = {}, label) {
  const left = [...(current || [])];
  const changes = [];
  const kept = [];
  const out = generated.map((g) => {
    const i = left.findIndex((r) => r.key === g.key);
    if (!(g.key in lastPrints)) changes.push(`${label} added: ${g.key}`);
    else if (fingerprint(row(g)) !== lastPrints[g.key]) changes.push(`${label} changed: ${g.key}`);
    if (i === -1) return { ...g };
    const [mine] = left.splice(i, 1);
    const untouched = fingerprint(row(mine)) === lastPrints[g.key];
    if (!untouched && g.key in lastPrints && fingerprint(row(g)) !== lastPrints[g.key]) kept.push(`${label} ${g.key}`);
    return untouched ? { ...g } : { ...mine, ...(g.description ? { description: g.description } : {}) };
  });
  const genKeys = new Set(generated.map((g) => g.key));
  for (const key of Object.keys(lastPrints)) if (!genKeys.has(key)) changes.push(`${label} removed: ${key}`);
  for (const r of left) if (genKeys.has(r.key) || !(r.key in lastPrints)) out.push(r);
  return { rows: out, changes, kept };
}

/** Brings one synced request in step with the spec. Returns { changes, kept } (empty when nothing changed). */
function mergeRequest(item, gen) {
  const last = item.openapi || { base: {}, rows: {} };
  const req = item.request;
  const g = gen.request;
  const changes = [];
  const kept = [];
  for (const [field, of] of Object.entries(FIELDS)) {
    const theirs = fingerprint(of(gen));
    if (theirs === last.base[field]) continue; // the spec didn't change it
    const mine = fingerprint(of(item));
    if (field === 'name') changes.push(`renamed to "${gen.name}"`);
    else if (field === 'path') changes.push('URL changed');
    else changes.push(`${FIELD_LABEL[field]} changed`);
    // A field the user hasn't changed since the last sync follows the spec; an edited one is kept.
    if (mine !== last.base[field] && mine !== theirs) { kept.push(FIELD_LABEL[field]); continue; }
    if (field === 'name') item.name = gen.name;
    else if (field === 'description') req.description = g.description;
    else if (field === 'body') req.body = g.body;
    else if (field === 'auth') req.auth = g.auth;
  }
  const { base, hash } = splitUrl(req.url);
  const path = fingerprint(FIELDS.path(item)) === last.base.path ? splitUrl(g.url).base : base;
  req.method = g.method;
  for (const [list, label] of Object.entries(ROWS)) {
    const merged = mergeRows(req[list], g[list] || [], (last.rows && last.rows[list]) || {}, label);
    req[list] = merged.rows;
    changes.push(...merged.changes);
    kept.push(...merged.kept);
  }
  req.url = withQuery(path, req.params, hash);
  if (fingerprint(examplesOf(gen)) !== last.base.examples) changes.push('responses changed');
  // Response examples always follow the spec; they keep their ids when their names match.
  const ids = new Map((item.examples || []).map((e) => [e.name, e.id]));
  item.examples = (gen.examples || []).map((e) => ({ ...e, id: ids.get(e.name) || e.id }));
  item.openapi = snapshot(gen);
  return { changes, kept };
}

const walk = (items, fn, parent = null) => {
  for (const it of [...items]) {
    fn(it, items, parent);
    if (it.type === 'folder') walk(it.items || [], fn, it);
  }
};

/**
 * The collection for a spec, with its requests pointing at {{variable}} (the base URL variable the
 * discovery source writes into the environment) instead of a collection variable.
 */
function buildCollection(doc, { variable }) {
  const col = importOpenApi(doc, { operations: true });
  const swap = (url) => String(url).replace(/\{\{baseUrl\}\}/g, `{{${variable}}}`);
  walk(col.items, (it) => {
    if (it.type !== 'request') return;
    const { base, hash } = splitUrl(swap(it.request.url));
    it.request.url = withQuery(base, it.request.params, hash);
    for (const ex of it.examples || []) if (ex.request) ex.request.url = it.request.url;
  });
  col.variables = col.variables.filter((v) => v.key !== 'baseUrl');
  col.openapi = { spec: specInfo(doc) };
  return col;
}

/** The operations in a generated collection: [{ method, path, name, folder }]. */
function operations(col) {
  const out = [];
  walk(col.items, (it, list, parent) => {
    if (it.type === 'request' && it.openapi) out.push({ method: it.request.method, path: it.openapi.op.slice(it.openapi.op.indexOf(' ') + 1), name: it.name, folder: parent ? parent.name : '' });
  });
  return out;
}

/**
 * The environment values for the secrets the collection's auth asks for, filled from the token the
 * source fetches the spec with (the same token usually works for its operations).
 */
function secretVariables(col, token) {
  const t = String(token || '').trim();
  if (!t) return [];
  const names = new Set((col.variables || []).map((v) => v.key));
  const key = names.has('token') ? 'token' : names.has('apiKey') ? 'apiKey' : null;
  const value = key === 'token' ? t.replace(/^bearer\s+/i, '') : t;
  // A token written as {{token}} already is that variable.
  return key && value !== `{{${key}}}` ? [{ key, value }] : [];
}

const collectionFields = {
  name: (c) => c.name,
  description: (c) => c.description || '',
  auth: (c) => [c.auth && c.auth.type, (c.auth && c.auth[c.auth.type]) || null],
};
const collectionSnapshot = (c, sourceId) => ({
  sourceId, spec: c.openapi && c.openapi.spec,
  base: Object.fromEntries(Object.entries(collectionFields).map(([f, of]) => [f, fingerprint(of(c))])),
});

/**
 * Brings `existing` (the collection made by an earlier sync, or null) in step with `generated` (from
 * buildCollection). It changes `existing` in place, so pass a copy to only find out what would change.
 *
 * Returns { collection, diff }:
 *   diff.spec     { previous, current, unchanged, sameVersion }: the versions compared; sameVersion
 *                 means the content changed but info.version didn't
 *   diff.changes  [{ kind: 'added' | 'changed' | 'removed' | 'kept', op, name, details, kept }]:
 *                 "kept" (kind) is a request whose operation left the spec but which the user had
 *                 changed; `kept` (field) lists the user's edits kept over the spec's
 *   diff.added / updated / removed / kept   request names, for counts
 */
function mergeCollection(existing, generated, { sourceId } = {}) {
  const previous = (existing && existing.openapi && existing.openapi.spec) || null;
  const current = generated.openapi.spec;
  const diff = {
    spec: { previous, current, unchanged: !!previous && previous.hash === current.hash, sameVersion: !!previous && previous.hash !== current.hash && previous.version === current.version },
    changes: [], added: [], updated: [], removed: [], kept: [], collection: [],
  };
  const note = (kind, item, details = [], kept = []) => {
    diff.changes.push({ kind, op: item.openapi ? item.openapi.op : '', name: item.name, details, kept });
    diff[kind === 'changed' ? 'updated' : kind].push(item.name);
  };
  if (!existing) {
    walk(generated.items, (it) => {
      if (it.type === 'request' && it.openapi) { it.openapi = snapshot(it); note('added', it); }
    });
    generated.openapi = collectionSnapshot(generated, sourceId);
    return { collection: generated, diff };
  }
  const col = existing;
  const last = (col.openapi && col.openapi.base) || {};
  for (const [field, of] of Object.entries(collectionFields)) {
    if (fingerprint(of(generated)) === last[field]) continue;
    const userEdited = fingerprint(of(col)) !== last[field];
    diff.collection.push(`${field} changed${userEdited ? ' (kept yours)' : ''}`);
    if (!userEdited) col[field] = generated[field];
  }
  col.variables = col.variables || [];
  for (const v of generated.variables || []) {
    if (col.variables.some((x) => x.key === v.key)) continue;
    col.variables.push(v);
    diff.collection.push(`variable added: ${v.key}`);
  }

  // The synced requests, wherever the user has moved them.
  const synced = new Map();
  walk(col.items, (it, list) => { if (it.type === 'request' && it.openapi && it.openapi.op) synced.set(it.openapi.op, { item: it, list }); });

  const folderFor = (tag) => {
    if (!tag) return col.items;
    let f = col.items.find((x) => x.type === 'folder' && (x.openapiTag === tag || x.name === tag));
    if (!f) {
      const g = generated.items.find((x) => x.type === 'folder' && x.openapiTag === tag);
      f = { ...g, items: [] };
      col.items.push(f);
    }
    return f.items;
  };
  walk(generated.items, (gen, list, parent) => {
    if (gen.type !== 'request' || !gen.openapi) return;
    const found = synced.get(gen.openapi.op);
    if (found) {
      synced.delete(gen.openapi.op);
      const { changes, kept } = mergeRequest(found.item, gen);
      if (changes.length) note('changed', found.item, changes, kept);
      return;
    }
    gen.openapi = snapshot(gen);
    folderFor(parent && parent.openapiTag).push(gen);
    note('added', gen);
  });

  // Operations no longer in the spec.
  for (const { item, list } of synced.values()) {
    if (edited(item)) {
      note('kept', item, ['removed from the spec; kept because you changed it']);
      delete item.openapi;
    } else {
      note('removed', item);
      list.splice(list.indexOf(item), 1);
    }
  }
  // Tag folders the sync made and that are now empty.
  const prune = (items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'folder') continue;
      prune(it.items || []);
      if (it.openapiTag && !(it.items || []).length && !it.preRequestScript && !it.testScript) items.splice(i, 1);
    }
  };
  prune(col.items);
  col.openapi = collectionSnapshot(generated, sourceId);
  return { collection: col, diff };
}

module.exports = { buildCollection, mergeCollection, operations, secretVariables, specInfo, edited };
