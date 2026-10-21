'use strict';

/**
 * What an OpenAPI document accepts, operation by operation, and whether a request still fits it.
 *
 * shapesOf(doc) keeps, for each operation ("GET /orders/{id}"): its method and path, whether it is
 * deprecated, its query and header parameters (required, enum, type) and its JSON body's top-level
 * fields (required, type). checkRequest(def, shape) lists what doesn't fit: a missing required
 * parameter or field, one the spec doesn't know, a value outside an enum, a wrong JSON type, or a
 * deprecated operation. findShape matches a request to its operation, by the op it was generated
 * from or by method and path under the source's base URL variable.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function resolver(doc) {
  return (o) => {
    const seen = new Set();
    while (o && typeof o.$ref === 'string' && o.$ref.startsWith('#/') && !seen.has(o.$ref)) {
      seen.add(o.$ref);
      o = o.$ref.slice(2).split('/').map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~')).reduce((a, p) => (a == null ? undefined : a[p]), doc);
    }
    return o || {};
  };
}

const typeOf = (schema) => {
  const t = Array.isArray(schema.type) ? schema.type.filter((x) => x !== 'null') : [schema.type];
  return t.filter(Boolean);
};

/** { "GET /orders/{id}": { method, path, deprecated, query, headers, body } } for an OpenAPI 3 or Swagger 2 document. */
function shapesOf(doc) {
  const ref = resolver(doc);
  const out = {};
  for (const [p, rawItem] of Object.entries((doc && doc.paths) || {})) {
    const item = ref(rawItem);
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map(ref);
      const param = (x) => {
        const s = ref(x.schema || x);
        return { required: !!x.required, ...(s.enum ? { enum: s.enum.map(String) } : {}), ...(typeOf(s).length ? { type: typeOf(s) } : {}) };
      };
      const shape = { method: method.toUpperCase(), path: p, deprecated: !!op.deprecated, query: {}, headers: {} };
      for (const x of params) {
        if (x.in === 'query') shape.query[x.name] = param(x);
        if (x.in === 'header') shape.headers[x.name.toLowerCase()] = param(x);
      }
      // A JSON body's top-level fields (OpenAPI 3 requestBody, or a Swagger 2 body parameter).
      let schema = null;
      if (op.requestBody) {
        const content = ref(op.requestBody).content || {};
        const json = Object.entries(content).find(([t]) => /(^|\/|\+)json\b/i.test(t));
        if (json) schema = ref(json[1].schema);
      } else {
        const b = params.find((x) => x.in === 'body');
        if (b) schema = ref(b.schema);
      }
      if (schema) {
        const all = schema.allOf ? Object.assign({}, ...schema.allOf.map(ref).map((s) => s.properties || {})) : schema.properties || {};
        const required = schema.allOf ? schema.allOf.map(ref).flatMap((s) => s.required || []) : schema.required || [];
        shape.body = {
          required,
          open: schema.additionalProperties !== false && !Object.keys(all).length,
          properties: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { type: typeOf(ref(v)), ...(ref(v).enum ? { enum: ref(v).enum.map(String) } : {}) }])),
        };
      }
      out[`${shape.method} ${p}`] = shape;
    }
  }
  return out;
}

const jsonType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const fits = (types, v) => !types || !types.length || types.some((t) => t === jsonType(v) || (t === 'number' && jsonType(v) === 'integer'));
const hasVar = (s) => /\{\{[^{}]+\}\}/.test(String(s));

/**
 * What in a request doesn't fit an operation's shape: [{ level: 'error' | 'warning', message }].
 * {{variables}} are taken on trust, since their values are only known when sending.
 */
function checkRequest(def, shape) {
  const out = [];
  if (!shape) return out;
  const warn = (message) => out.push({ level: 'warning', message });
  const error = (message) => out.push({ level: 'error', message });
  if (shape.deprecated) warn(`${shape.method} ${shape.path} is deprecated in the spec`);
  const sent = (def.params || []).filter((p) => p.key && p.enabled !== false);
  for (const [name, q] of Object.entries(shape.query)) {
    const p = sent.find((x) => x.key === name);
    if (q.required && !p) error(`Missing required query parameter "${name}"`);
    if (p && q.enum && !hasVar(p.value) && !q.enum.includes(String(p.value))) warn(`Query parameter "${name}" is "${p.value}"; the spec allows ${q.enum.map((x) => `"${x}"`).join(', ')}`);
  }
  for (const p of sent) if (!shape.query[p.key]) warn(`Query parameter "${p.key}" is not in the spec`);
  const headers = (def.headers || []).filter((x) => x.key && x.enabled !== false).map((x) => x.key.toLowerCase());
  for (const [name, hd] of Object.entries(shape.headers)) if (hd.required && !headers.includes(name)) error(`Missing required header "${name}"`);
  const b = def.body || {};
  if (shape.body && b.mode === 'raw' && (b.rawLanguage || 'json') === 'json' && b.raw && b.raw.trim()) {
    let body;
    try { body = JSON.parse(b.raw.replace(/"?\{\{[^{}]+\}\}"?/g, '"__var__"')); } catch { body = undefined; }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const k of shape.body.required) if (!(k in body)) error(`Missing required body field "${k}"`);
      if (!shape.body.open) {
        for (const [k, v] of Object.entries(body)) {
          const prop = shape.body.properties[k];
          if (!prop) { warn(`Body field "${k}" is not in the spec`); continue; }
          if (v !== '__var__' && !fits(prop.type, v)) warn(`Body field "${k}" is ${jsonType(v)}; the spec says ${prop.type.join(' or ')}`);
          if (prop.enum && v !== '__var__' && !prop.enum.includes(String(v))) warn(`Body field "${k}" is ${JSON.stringify(v)}; the spec allows ${prop.enum.map((x) => `"${x}"`).join(', ')}`);
        }
      }
    }
  }
  return out;
}

const pathPattern = (p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, '[^/]+')}/?$`);

/**
 * The operation a request is for: by the op it was generated from, or by its method and its path
 * after {{variable}} (the source's base URL variable). Returns { key, shape } — shape null when the
 * request is for this API but no operation has that method and path any more — or null when the
 * request isn't for this API at all.
 */
function findShape(def, shapes, { op, variable } = {}) {
  if (!shapes) return null;
  if (op) return { key: op, shape: shapes[op] || null };
  const m = variable && new RegExp(`^\\{\\{\\s*${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}([^?#]*)`).exec(String(def.url || ''));
  if (!m) return null;
  const path = (m[1] || '/').replace(/\/:([A-Za-z_][\w-]*)/g, '/{$1}');
  const method = String(def.method || 'GET').toUpperCase();
  for (const [key, shape] of Object.entries(shapes)) if (shape.method === method && pathPattern(shape.path).test(path)) return { key, shape };
  return { key: `${method} ${path}`, shape: null };
}

module.exports = { shapesOf, checkRequest, findShape };
