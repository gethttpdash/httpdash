'use strict';

/**
 * Payloads: named variations of a request's data, so repeated calls to an endpoint don't all send
 * the same thing.
 *
 * request.payloads = {
 *   mode: 'off' | 'sequence' | 'random',
 *   items: [{ id, name, enabled, body, variables: [{ key, value, enabled }] }],
 * }
 * A payload's variables apply to that call only, at the highest precedence, so {{orderId}} anywhere
 * in the request (URL, params, headers, body, auth) takes the payload's value. Its body, when not
 * empty, replaces the request's body as raw text.
 *
 * In sequence mode each request walks through its payloads in turn; the position lives here, so
 * single sends, collection runs and monitors share it.
 */

const positions = new Map(); // request key -> next index among the enabled payloads

/**
 * Picks the payload for one call: `index` forces one (e.g. "Send with this"), even with payloads
 * off. Returns { index, item } (index into payloads.items) or null to send the request as it is.
 */
function choose(request, { key, index } = {}) {
  const p = request && request.payloads;
  if (!p || !Array.isArray(p.items)) return null;
  if (index != null) return p.items[index] ? { index, item: p.items[index] } : null;
  const enabled = p.items.filter((i) => i && i.enabled !== false);
  if (!enabled.length || !p.mode || p.mode === 'off') return null;
  let item;
  if (p.mode === 'random') item = enabled[Math.floor(Math.random() * enabled.length)];
  else {
    const n = positions.get(key) || 0;
    positions.set(key, n + 1);
    item = enabled[n % enabled.length];
  }
  return { index: p.items.indexOf(item), item };
}

/** Applies a chosen payload to a request (a copy) and its scopes. Returns how it's reported. */
function apply(request, scopes, { index, item }) {
  for (const v of item.variables || []) if (v.key && v.enabled !== false) scopes.local[v.key] = v.value == null ? '' : String(v.value);
  if (item.body != null && String(item.body).trim() !== '') {
    const body = request.body || {};
    request.body = { ...body, mode: 'raw', raw: String(item.body), rawLanguage: body.mode === 'raw' && body.rawLanguage ? body.rawLanguage : 'json' };
  }
  return { index, name: item.name || `Payload ${index + 1}`, count: request.payloads.items.length };
}

/**
 * Payloads from data rows (a CSV or JSON data file): "name" names the payload, "body" (text, or an
 * object written as JSON) is its body, and every other column is one of its variables.
 */
function fromRows(rows) {
  return (rows || []).filter((r) => r && typeof r === 'object').map((row, i) => {
    const { name, body, ...vars } = row;
    return {
      name: name != null && String(name).trim() ? String(name) : `Row ${i + 1}`,
      enabled: true,
      body: body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      variables: Object.entries(vars).map(([key, value]) => ({ key, value: value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value), enabled: true })),
    };
  });
}

/** Forgets where sequences are (e.g. so a run starts from the first payload). */
function reset(key) {
  if (key === undefined) positions.clear();
  else positions.delete(key);
}

module.exports = { choose, apply, fromRows, reset };
