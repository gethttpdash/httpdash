'use strict';

// Import/export of Postman collection (v2.0 / v2.1) and environment files, plus OpenAPI/Swagger import (JSON or YAML).
const { uid, newRequestDef, newCollection, newFolder, newEnvironment } = require('./model');
const { paramsFromUrl } = require('./curl');
const { STATUS_CODES } = require('http');
const YAML = require('yaml');
const oauth2 = require('./oauth2');

const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const text = (d) => (d == null ? '' : typeof d === 'string' ? d : d.content || '');
const kv = (list) => (Array.isArray(list) ? list : []).map((i) => ({
  key: i.key || '', value: i.value == null ? '' : typeof i.value === 'string' ? i.value : JSON.stringify(i.value),
  enabled: !i.disabled, description: text(i.description),
}));

// ---- Import -------------------------------------------------------------------------------

function importAuth(auth) {
  if (auth === undefined || auth === null) return { type: 'inherit' };
  const type = auth.type === 'noauth' ? 'none' : auth.type;
  const params = auth[auth.type];
  const obj = {};
  if (Array.isArray(params)) for (const p of params) obj[p.key] = p.value;
  else if (params && typeof params === 'object') Object.assign(obj, params);
  const out = { type };
  if (type === 'apikey') out.apikey = { key: obj.key || '', value: obj.value || '', in: obj.in || 'header' };
  else if (type === 'oauth2') out.oauth2 = oauth2.fromPostman(obj);
  else if (type === 'awsv4') out.awsv4 = { accessKey: obj.accessKey || '', secretKey: obj.secretKey || '', region: obj.region || '', service: obj.service || '', sessionToken: obj.sessionToken || '' };
  else if (['basic', 'bearer', 'digest'].includes(type)) out[type] = obj;
  else if (type !== 'none') return { type: 'none' }; // Unsupported auth types (ntlm, hawk, ...) fall back to none.
  return out;
}

function importScripts(events) {
  const out = { preRequestScript: '', testScript: '' };
  for (const e of events || []) {
    const exec = e.script && e.script.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : exec || '';
    if (e.listen === 'prerequest') out.preRequestScript = code;
    if (e.listen === 'test') out.testScript = code;
  }
  return out;
}

function importUrl(url) {
  if (!url) return { url: '', params: [], pathVariables: [] };
  if (typeof url === 'string') return { url, params: paramsFromUrl(url), pathVariables: [] };
  let raw = url.raw;
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const p = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    const q = (url.query || []).filter((x) => !x.disabled).map((x) => `${x.key}=${x.value || ''}`).join('&');
    raw = `${url.protocol ? url.protocol + '://' : ''}${host}${url.port ? ':' + url.port : ''}${p ? '/' + p : ''}${q ? '?' + q : ''}`;
  }
  const params = url.query ? kv(url.query) : paramsFromUrl(raw);
  return { url: raw, params, pathVariables: kv(url.variable) };
}

function importBody(body) {
  const def = newRequestDef().body;
  if (!body || !body.mode) return def;
  const out = { ...def, mode: body.mode };
  if (body.mode === 'raw') {
    out.raw = body.raw || '';
    out.rawLanguage = (body.options && body.options.raw && body.options.raw.language) || (/^\s*[{[]/.test(out.raw) ? 'json' : 'text');
  } else if (body.mode === 'urlencoded') out.urlencoded = kv(body.urlencoded);
  else if (body.mode === 'formdata') {
    out.formdata = (body.formdata || []).map((i) => ({ key: i.key || '', value: i.value || '', type: i.type === 'file' ? 'file' : 'text', src: i.src || '', enabled: !i.disabled, contentType: i.contentType || '' }));
  } else if (body.mode === 'file') {
    out.mode = 'binary';
    out.binary = (body.file && body.file.src) || '';
  } else if (body.mode === 'graphql') {
    out.graphql = { query: (body.graphql && body.graphql.query) || '', variables: (body.graphql && body.graphql.variables) || '' };
  } else out.mode = 'none';
  return out;
}

function importItem(item) {
  if (Array.isArray(item.item)) {
    const folder = newFolder(item.name || 'Folder');
    folder.description = text(item.description);
    folder.auth = importAuth(item.auth);
    Object.assign(folder, importScripts(item.event));
    folder.items = item.item.map(importItem);
    return folder;
  }
  const r = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request || {};
  const def = newRequestDef({
    method: (r.method || 'GET').toUpperCase(),
    ...importUrl(r.url),
    headers: typeof r.header === 'string' ? [] : kv(r.header),
    body: importBody(r.body),
    auth: importAuth(r.auth),
    description: text(r.description || item.description),
    ...importScripts(item.event),
  });
  const examples = (item.response || []).map((ex) => ({
    id: uid(), name: ex.name || 'Example', status: ex.code || 0, statusText: ex.status || '',
    headers: (ex.header || []).map((h) => [h.key, h.value]), body: ex.body || '',
  }));
  return { id: uid(), type: 'request', name: item.name || 'Request', request: def, examples };
}

function importPostmanCollection(json) {
  if (!json.info || !Array.isArray(json.item)) throw new Error('Not a Postman collection');
  const col = newCollection(json.info.name || 'Imported Collection');
  col.description = text(json.info.description);
  col.auth = importAuth(json.auth);
  if (col.auth.type === 'inherit') col.auth = { type: 'none' };
  Object.assign(col, importScripts(json.event));
  col.variables = kv(json.variable);
  col.items = json.item.map(importItem);
  return col;
}

function importPostmanEnvironment(json) {
  const env = newEnvironment(json.name || 'Imported Environment');
  env.values = (json.values || []).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value), enabled: v.enabled !== false, secret: v.type === 'secret' }));
  return env;
}

// Imports OpenAPI 3 / Swagger 2 JSON documents as a collection with one folder per tag.
// Media types treated as JSON: application/json, application/problem+json, application/vnd.api+json, text/json...
const JSON_TYPE = /(^|\/|\+)json\b/i;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function importOpenApi(doc) {
  const col = newCollection((doc.info && doc.info.title) || 'OpenAPI Import');
  col.description = (doc.info && doc.info.description) || '';

  // Follows local references ("#/components/schemas/Pet"), including chains, and stops on cycles.
  // References to other files aren't followed.
  const resolveRef = (o) => {
    const seen = new Set();
    while (o && typeof o.$ref === 'string') {
      if (!o.$ref.startsWith('#/') || seen.has(o.$ref)) return {};
      seen.add(o.$ref);
      o = o.$ref.slice(2).split('/')
        .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((acc, p) => (acc == null ? undefined : acc[p]), doc);
    }
    return o || {};
  };

  let baseUrl = '';
  if (doc.openapi && doc.servers && doc.servers[0]) {
    baseUrl = doc.servers[0].url || '';
    for (const [k, v] of Object.entries(doc.servers[0].variables || {})) baseUrl = baseUrl.replace(`{${k}}`, v.default);
  } else if (doc.swagger) {
    baseUrl = `${(doc.schemes && doc.schemes[0]) || 'https'}://${doc.host || 'localhost'}${doc.basePath || ''}`;
  }
  // A relative server ("/api/v1") is relative to wherever the spec is hosted, which we don't know.
  if (!/^[a-z]+:\/\//i.test(baseUrl)) baseUrl = `http://localhost${baseUrl.startsWith('/') ? baseUrl : ''}`;
  col.variables = [{ key: 'baseUrl', value: baseUrl.replace(/\/$/, ''), enabled: true }];

  const sample = (schema, depth = 0) => {
    schema = resolveRef(schema);
    if (depth > 6) return null;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum) return schema.enum[0];
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => sample(s, depth + 1)));
    if (schema.oneOf || schema.anyOf) return sample((schema.oneOf || schema.anyOf)[0], depth + 1);
    // OpenAPI 3.1 allows a list of types, such as ["string", "null"].
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    switch (type) {
      case 'object': case undefined: {
        if (!schema.properties) return type ? {} : null;
        return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, sample(v, depth + 1)]));
      }
      case 'array': return [sample(schema.items, depth + 1)];
      case 'integer': case 'number': return 0;
      case 'boolean': return true;
      default: return { 'date-time': new Date(0).toISOString(), date: '1970-01-01', uuid: '00000000-0000-0000-0000-000000000000', email: 'user@example.com', uri: 'https://example.com' }[schema.format] || 'string';
    }
  };
  // The example for a media type object: its example, the first of its examples, or one built from its schema.
  const mediaExample = (media) => {
    if (media.example !== undefined) return media.example;
    const first = media.examples && Object.values(media.examples)[0];
    if (first) return resolveRef(first).value;
    return sample(media.schema);
  };
  const paramValue = (x) => {
    const first = x.examples && Object.values(x.examples)[0];
    const s = resolveRef(x.schema);
    const v = x.example !== undefined ? x.example : first ? resolveRef(first).value : s.example !== undefined ? s.example : s.default;
    return v === undefined || v === null ? '' : String(v);
  };
  const pickContent = (content, test) => Object.entries(content || {}).find(([type]) => test.test(type));

  // Security schemes become auth settings, with variables for the secrets.
  const schemes = (doc.components && doc.components.securitySchemes) || doc.securityDefinitions || {};
  const neededVars = new Set();
  const schemeAuth = (s, scopes) => {
    const type = String(s.type || '').toLowerCase();
    const scheme = String(s.scheme || '').toLowerCase();
    if (type === 'http' && scheme === 'bearer') { neededVars.add('token'); return { type: 'bearer', bearer: { token: '{{token}}' } }; }
    if ((type === 'http' && scheme === 'basic') || type === 'basic') { neededVars.add('username').add('password'); return { type: 'basic', basic: { username: '{{username}}', password: '{{password}}' } }; }
    if (type === 'apikey' && s.in !== 'cookie') { neededVars.add('apiKey'); return { type: 'apikey', apikey: { key: s.name || 'X-API-Key', value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' } }; }
    if (type === 'oauth2') {
      const flows = s.flows || {};
      const v2 = { accessCode: 'authorizationCode', application: 'clientCredentials', implicit: 'implicit', password: 'password' }[s.flow];
      if (v2) flows[v2] = { authorizationUrl: s.authorizationUrl, tokenUrl: s.tokenUrl };
      const [flow, f] = ['authorizationCode', 'clientCredentials', 'password', 'implicit'].map((k) => [k, flows[k]]).find(([, v]) => v) || [];
      if (!flow) return null;
      neededVars.add('clientId');
      if (flow !== 'authorizationCode' && flow !== 'implicit') neededVars.add('clientSecret');
      return {
        type: 'oauth2',
        oauth2: {
          grantType: { authorizationCode: 'authorization_code_with_pkce', clientCredentials: 'client_credentials', password: 'password', implicit: 'implicit' }[flow],
          authUrl: f.authorizationUrl || '', accessTokenUrl: f.tokenUrl || '', callbackUrl: '', clientId: '{{clientId}}',
          clientSecret: flow === 'clientCredentials' || flow === 'password' ? '{{clientSecret}}' : '', scope: (scopes || []).join(' '),
          accessToken: '', headerPrefix: 'Bearer', addTo: 'header', clientAuth: 'header', pkceMethod: 'S256',
        },
      };
    }
    return null;
  };
  // A security requirement list: [] means no auth; otherwise the first scheme we support.
  const authFor = (requirements) => {
    if (!Array.isArray(requirements)) return null;
    if (!requirements.length) return { type: 'none' };
    for (const req of requirements) {
      for (const [name, scopes] of Object.entries(req || {})) {
        const a = schemeAuth(resolveRef(schemes[name]), scopes);
        if (a) return a;
      }
    }
    return null;
  };
  col.auth = authFor(doc.security) || { type: 'none' };

  const folders = new Map();
  for (const [p, rawOps] of Object.entries(doc.paths || {})) {
    const ops = resolveRef(rawOps);
    for (const [method, op] of Object.entries(ops)) {
      if (!METHODS.includes(method) || !op) continue;
      const params = [...(ops.parameters || []), ...(op.parameters || [])].map(resolveRef);
      const query = params.filter((x) => x.in === 'query').map((x) => ({ key: x.name, value: paramValue(x), enabled: !!x.required, description: x.description || '' }));
      const headers = params.filter((x) => x.in === 'header').map((x) => ({ key: x.name, value: paramValue(x), enabled: true, description: x.description || '' }));
      const pathVariables = params.filter((x) => x.in === 'path').map((x) => ({ key: x.name, value: paramValue(x), enabled: true, description: x.description || '' }));
      const pathPart = p.replace(/\{([^}]+)\}/g, ':$1');
      const qs = query.filter((q) => q.enabled).map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
      const def = newRequestDef({
        method: method.toUpperCase(), url: `{{baseUrl}}${pathPart}${qs ? '?' + qs : ''}`, params: query, headers, pathVariables,
        description: op.description || op.summary || '',
      });
      if (op.requestBody) {
        const content = resolveRef(op.requestBody).content || {};
        const json = pickContent(content, JSON_TYPE);
        if (json) {
          def.body.mode = 'raw';
          def.body.rawLanguage = 'json';
          def.body.raw = JSON.stringify(mediaExample(json[1]), null, 2);
          def.headers.push({ key: 'Content-Type', value: json[0], enabled: true });
        } else if (content['application/x-www-form-urlencoded']) {
          const s = resolveRef(content['application/x-www-form-urlencoded'].schema);
          def.body.mode = 'urlencoded';
          def.body.urlencoded = Object.keys(s.properties || {}).map((k) => ({ key: k, value: '', enabled: true }));
        } else if (content['multipart/form-data']) {
          const s = resolveRef(content['multipart/form-data'].schema);
          def.body.mode = 'formdata';
          def.body.formdata = Object.entries(s.properties || {}).map(([k, v]) => ({ key: k, value: '', type: resolveRef(v).format === 'binary' ? 'file' : 'text', enabled: true }));
        } else {
          const other = Object.entries(content)[0];
          if (other) {
            const ex = mediaExample(other[1]);
            def.body.mode = 'raw';
            def.body.rawLanguage = /xml/.test(other[0]) ? 'xml' : 'text';
            def.body.raw = typeof ex === 'string' ? ex : ex == null ? '' : JSON.stringify(ex, null, 2);
            def.headers.push({ key: 'Content-Type', value: other[0], enabled: true });
          }
        }
      } else {
        const bodyParam = params.find((x) => x.in === 'body');
        const formParams = params.filter((x) => x.in === 'formData');
        if (bodyParam) {
          def.body.mode = 'raw';
          def.body.rawLanguage = 'json';
          def.body.raw = JSON.stringify(sample(bodyParam.schema), null, 2);
        } else if (formParams.length) {
          const files = formParams.some((x) => x.type === 'file');
          def.body.mode = files ? 'formdata' : 'urlencoded';
          def.body[def.body.mode] = formParams.map((x) => ({ key: x.name, value: '', enabled: true, ...(files ? { type: x.type === 'file' ? 'file' : 'text' } : {}) }));
        }
      }
      const opAuth = authFor(op.security);
      if (opAuth && JSON.stringify(opAuth) !== JSON.stringify(col.auth)) def.auth = opAuth;

      // Response examples, so the collection's mock server works straight after importing.
      const examples = [];
      for (const [code, rawResponse] of Object.entries(op.responses || {})) {
        const r = resolveRef(rawResponse);
        const status = /^\d{3}$/.test(code) ? Number(code) : /^\dXX$/i.test(code) ? Number(code[0]) * 100 : null;
        if (!status) continue;
        let type = null;
        let body;
        const json = pickContent(r.content, JSON_TYPE);
        if (json) [type, body] = [json[0], mediaExample(json[1])];
        else if (r.examples && r.examples['application/json'] !== undefined) [type, body] = ['application/json', r.examples['application/json']];
        else if (r.schema) [type, body] = ['application/json', sample(r.schema)];
        if (body === undefined && status !== 204) continue;
        examples.push({
          id: uid(), name: `${code} ${r.description || STATUS_CODES[status] || ''}`.trim(), status, statusText: STATUS_CODES[status] || '',
          headers: type ? [['Content-Type', type]] : [], body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2),
          request: JSON.parse(JSON.stringify(def)),
        });
      }

      const item = { id: uid(), type: 'request', name: op.summary || op.operationId || `${method.toUpperCase()} ${p}`, request: def, examples };
      const tag = (op.tags && op.tags[0]) || null;
      if (tag) {
        if (!folders.has(tag)) {
          const f = newFolder(tag);
          folders.set(tag, f);
          col.items.push(f);
        }
        folders.get(tag).items.push(item);
      } else col.items.push(item);
    }
  }
  for (const key of neededVars) col.variables.push({ key, value: '', enabled: true });
  return col;
}

/**
 * Reads an imported file's text: JSON, or YAML (used by most OpenAPI specs). YAML aliases are
 * limited, so a malicious file can't expand into gigabytes.
 */
function parseDocument(text) {
  const t = String(text).replace(/^﻿/, '');
  try {
    return JSON.parse(t);
  } catch (jsonError) {
    if (/^\s*[{[]/.test(t)) throw new Error(`Invalid JSON: ${jsonError.message}`);
    let doc;
    try { doc = YAML.parse(t, { maxAliasCount: 100 }); } catch (e) { throw new Error(`Could not read the file as JSON or YAML: ${e.message}`); }
    if (!doc || typeof doc !== 'object') throw new Error('Unrecognised file format: expected a JSON or YAML document.');
    return doc;
  }
}

// Detects the type of an imported file's text (JSON or YAML) and converts it.
const importText = (text) => importAny(parseDocument(text));

/** Detects the type of an imported JSON document and converts it. */
function importAny(json) {
  const backup = require('./backup');
  if (backup.isBackup(json)) return { kind: 'backup', data: json, summary: backup.summarize(json.workspace) };
  if (json.info && Array.isArray(json.item)) return { kind: 'collection', data: importPostmanCollection(json) };
  if ((json.openapi || json.swagger) && json.paths) return { kind: 'collection', data: importOpenApi(json) };
  if (Array.isArray(json.values) && (json._postman_variable_scope === 'environment' || json.name !== undefined)) {
    if (json._postman_variable_scope === 'globals') return { kind: 'globals', data: importPostmanEnvironment(json).values };
    return { kind: 'environment', data: importPostmanEnvironment(json) };
  }
  if (json.type === 'collection' && Array.isArray(json.items)) return { kind: 'collection', data: reId(json) };
  throw new Error('Unrecognised file format. Supported: HttpDash backup, Postman collection v2/v2.1, Postman environment / globals, OpenAPI 3 / Swagger 2 (JSON or YAML).');
}

// Gives every node of a native collection fresh ids so re-importing never collides.
function reId(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const ids = new Map();
  const walk = (n) => { const id = uid(); ids.set(n.id, id); n.id = id; (n.items || []).forEach(walk); };
  walk(copy);
  // Keep auth dependencies pointing at the re-identified requests.
  const remap = (n) => {
    const dep = n.type === 'request' ? n.request && n.request.dependency : n.dependency;
    if (dep && ids.has(dep.requestId)) dep.requestId = ids.get(dep.requestId);
    (n.items || []).forEach(remap);
  };
  remap(copy);
  return copy;
}

// ---- Export -------------------------------------------------------------------------------

function exportAuth(auth) {
  if (!auth || auth.type === 'inherit') return undefined;
  if (auth.type === 'none') return { type: 'noauth' };
  const params = auth.type === 'oauth2' ? oauth2.toPostman(auth.oauth2 || {}) : { ...(auth[auth.type] || {}) };
  return { type: auth.type, [auth.type]: Object.entries(params).map(([key, value]) => ({ key, value, type: 'string' })) };
}

const exportKv = (list) => (list || []).map((i) => {
  const o = { key: i.key, value: i.value };
  if (i.enabled === false) o.disabled = true;
  if (i.description) o.description = i.description;
  return o;
});

function exportEvents(node) {
  const ev = [];
  if (node.preRequestScript) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: node.preRequestScript.split('\n') } });
  if (node.testScript) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: node.testScript.split('\n') } });
  return ev.length ? ev : undefined;
}

function exportUrl(def) {
  const raw = def.url || '';
  const out = { raw };
  const m = raw.match(/^([a-z]+):\/\/([^/?#]*)([^?#]*)/i);
  if (m) {
    out.protocol = m[1];
    out.host = m[2].split('.');
    out.path = m[3].split('/').filter(Boolean);
  } else {
    const [hostPath] = raw.split('?');
    const [host, ...path] = hostPath.split('/');
    out.host = [host];
    out.path = path.filter(Boolean);
  }
  if (def.params && def.params.length) out.query = exportKv(def.params);
  if (def.pathVariables && def.pathVariables.length) out.variable = exportKv(def.pathVariables);
  return out;
}

function exportBody(b) {
  if (!b || b.mode === 'none') return undefined;
  if (b.mode === 'raw') return { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.rawLanguage || 'text' } } };
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: exportKv(b.urlencoded) };
  if (b.mode === 'formdata') {
    return { mode: 'formdata', formdata: (b.formdata || []).map((i) => ({ key: i.key, ...(i.type === 'file' ? { type: 'file', src: i.src } : { type: 'text', value: i.value }), ...(i.enabled === false ? { disabled: true } : {}) })) };
  }
  if (b.mode === 'binary') return { mode: 'file', file: { src: b.binary } };
  if (b.mode === 'graphql') return { mode: 'graphql', graphql: { query: b.graphql.query, variables: b.graphql.variables } };
  return undefined;
}

// Postman's collection format has no WebSocket requests, so those are left out of exports.
const isWebSocketItem = (item) => item.type !== 'folder' && item.request && item.request.protocol === 'websocket';

function exportItem(item) {
  if (item.type === 'folder') {
    return { name: item.name, description: item.description || undefined, item: item.items.filter((i) => !isWebSocketItem(i)).map(exportItem), auth: exportAuth(item.auth), event: exportEvents(item) };
  }
  const d = item.request;
  return {
    name: item.name,
    event: exportEvents(d),
    request: { method: d.method, header: exportKv(d.headers), body: exportBody(d.body), url: exportUrl(d), auth: exportAuth(d.auth), description: d.description || undefined },
    response: (item.examples || []).map((ex) => ({ name: ex.name, code: ex.status, status: ex.statusText, header: (ex.headers || []).map(([key, value]) => ({ key, value })), body: ex.body })),
  };
}

function exportCollection(col) {
  return JSON.parse(JSON.stringify({
    info: { _postman_id: col.id, name: col.name, description: col.description || undefined, schema: SCHEMA_V21 },
    item: col.items.filter((i) => !isWebSocketItem(i)).map(exportItem),
    auth: exportAuth(col.auth),
    event: exportEvents(col),
    variable: exportKv(col.variables),
  }));
}

function exportEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: env.values.map((v) => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'HttpDash/1.0',
  };
}

module.exports = { importAny, importText, parseDocument, importPostmanCollection, importPostmanEnvironment, importOpenApi, exportCollection, exportEnvironment };
