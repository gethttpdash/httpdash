'use strict';

/**
 * Service discovery: reads a registry (Consul, Eureka, Kubernetes or a custom JSON endpoint)
 * and turns each service into an environment variable such as orders_url = http://10.0.1.5:8080.
 * An OpenAPI document is a source too: its server becomes the variable, and its operations a
 * collection kept in step with it (see openapi-sync.js).
 *
 * Source config:
 * {
 *   provider: 'consul' | 'eureka' | 'kubernetes' | 'json' | 'openapi',
 *   url,                 // registry base URL (Consul agent, Eureka server, Kubernetes API server, or the JSON endpoint)
 *   token,               // optional: X-Consul-Token / Kubernetes bearer token / Authorization for JSON
 *   headers: [{key, value, enabled}],
 *   verifySSL: true,
 *   variablePattern: '{name}_url',   // how variable names are built
 *   // consul
 *   datacenter, tag, onlyHealthy: true, scheme: 'http',
 *   // eureka
 *   onlyUp: true,
 *   // kubernetes
 *   namespace: 'default', addressMode: 'cluster-dns' | 'cluster-ip' | 'external' | 'pods', labelSelector,
 *   // json
 *   listPath, nameField: 'name', urlField: 'url'  (urlField may be a template such as "http://{host}:{port}")
 *   // openapi (url is the document's)
 *   serviceName,         // names the variable; default: the document's title
 *   baseUrl,             // instead of the document's server
 *   syncRequests: true,  // keep a collection with a request per operation
 *   // registries: a collection per service from its own OpenAPI document (spec-collections.js)
 *   specCollections: false, specPaths: '/v3/api-docs, /openapi.json' (empty: the common paths),
 * }
 */
const httpClient = require('./http-client');
const { getPath } = require('./dependency');
const { parseDocument } = require('./postman');

class DiscoveryError extends Error {}

const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`;

async function fetchJson(url, cfg, settings, extraHeaders = [], { parse = JSON.parse, accept = 'application/json', what = 'JSON' } = {}) {
  const headers = [['Accept', accept], ['User-Agent', (settings && settings.userAgent) || 'HttpDash/1.0'], ...extraHeaders];
  for (const h of cfg.headers || []) if (h.key && h.enabled !== false) headers.push([h.key, h.value || '']);
  let res;
  try {
    res = await httpClient.send({
      method: 'GET', url, headers, body: null,
      timeout: (settings && settings.timeout) || 15000,
      verifySSL: cfg.verifySSL !== false && (!settings || settings.verifySSL !== false),
      followRedirects: true,
      proxy: settings && settings.proxy,
    });
  } catch (e) {
    throw Object.assign(new DiscoveryError(`Could not reach ${url}: ${e.message}`), { unreachable: true });
  }
  const text = res.body.toString('utf8');
  if (res.status >= 400) throw new DiscoveryError(`${url} returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
  try {
    return parse(text);
  } catch {
    throw new DiscoveryError(`${url} did not return ${what}`);
  }
}

const hostPort = (scheme, host, port) => {
  const h = host && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultPort = (scheme === 'https' && Number(port) === 443) || (scheme === 'http' && Number(port) === 80);
  return `${scheme}://${h}${port && !defaultPort ? `:${port}` : ''}`;
};

// ---- Providers ---------------------------------------------------------------------------

async function discoverConsul(cfg, settings) {
  const auth = cfg.token ? [['X-Consul-Token', cfg.token]] : [];
  const qs = (extra = {}) => {
    const p = new URLSearchParams();
    if (cfg.datacenter) p.set('dc', cfg.datacenter);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const catalog = await fetchJson(joinUrl(cfg.url, `/v1/catalog/services${qs()}`), cfg, settings, auth);
  const names = Object.keys(catalog).filter((n) => n !== 'consul' && (!cfg.tag || (catalog[n] || []).includes(cfg.tag)));
  const scheme = cfg.scheme || 'http';
  const services = [];
  const warnings = [];
  await Promise.all(names.map(async (name) => {
    const entries = await fetchJson(joinUrl(cfg.url, `/v1/health/service/${encodeURIComponent(name)}${qs({ passing: cfg.onlyHealthy === false ? '' : '1', tag: cfg.tag })}`), cfg, settings, auth);
    const instances = entries.map((e) => {
      const host = (e.Service && e.Service.Address) || (e.Node && e.Node.Address);
      return { id: e.Service && e.Service.ID, url: hostPort(scheme, host, e.Service && e.Service.Port), healthy: (e.Checks || []).every((c) => c.Status === 'passing') };
    });
    if (!instances.length) { warnings.push(`${name}: no ${cfg.onlyHealthy === false ? '' : 'healthy '}instances`); return; }
    services.push({ name, url: instances[0].url, instances, tags: catalog[name] || [] });
  }));
  return { services, warnings };
}

async function discoverEureka(cfg, settings) {
  const base = String(cfg.url).replace(/\/+$/, '');
  const url = /\/apps$/.test(base) ? base : /\/eureka$/.test(base) ? `${base}/apps` : `${base}/eureka/apps`;
  const auth = cfg.token ? [['Authorization', /^(basic|bearer) /i.test(cfg.token) ? cfg.token : `Bearer ${cfg.token}`]] : [];
  const json = await fetchJson(url, cfg, settings, auth);
  const apps = [].concat((json.applications && json.applications.application) || []);
  const services = [];
  const warnings = [];
  for (const app of apps) {
    const all = [].concat(app.instance || []);
    const instances = all.filter((i) => cfg.onlyUp === false || i.status === 'UP').map((i) => {
      const secure = i.securePort && (i.securePort['@enabled'] === 'true' || i.securePort['@enabled'] === true);
      const port = secure ? i.securePort.$ : i.port && i.port.$;
      const fromParts = hostPort(secure ? 'https' : 'http', i.hostName || i.ipAddr, port);
      const home = i.homePageUrl ? String(i.homePageUrl).replace(/\/+$/, '') : '';
      return { id: i.instanceId, url: home || fromParts, healthy: i.status === 'UP' };
    });
    if (!instances.length) { warnings.push(`${app.name}: no instances UP`); continue; }
    services.push({ name: String(app.name).toLowerCase(), url: instances[0].url, instances });
  }
  return { services, warnings };
}

async function discoverKubernetes(cfg, settings) {
  const ns = cfg.namespace || 'default';
  const sel = cfg.labelSelector ? `?labelSelector=${encodeURIComponent(cfg.labelSelector)}` : '';
  const path = ns === '*' ? `/api/v1/services${sel}` : `/api/v1/namespaces/${encodeURIComponent(ns)}/services${sel}`;
  const auth = cfg.token ? [['Authorization', `Bearer ${cfg.token}`]] : [];
  const json = await fetchJson(joinUrl(cfg.url, path), cfg, settings, auth);
  const mode = cfg.addressMode || 'cluster-dns';
  // In pods mode each ready pod behind a Service is an instance, read from the Service's endpoints.
  let endpoints = null;
  if (mode === 'pods') {
    const list = await fetchJson(joinUrl(cfg.url, path.replace(/\/services(\?|$)/, '/endpoints$1')), cfg, settings, auth);
    endpoints = new Map((list.items || []).map((e) => [`${e.metadata.namespace || ns}/${e.metadata.name}`, e]));
  }
  const services = [];
  const warnings = [];
  for (const svc of json.items || []) {
    const name = svc.metadata.name;
    const svcNs = svc.metadata.namespace || ns;
    const ports = (svc.spec && svc.spec.ports) || [];
    const port = ports.find((p) => /^https?$/.test(p.name || '')) || ports[0];
    if (!port) { warnings.push(`${name}: no ports`); continue; }
    const scheme = port.name === 'https' || port.port === 443 ? 'https' : 'http';
    let host;
    let p = port.port;
    const svcName = ns === '*' ? `${svcNs}_${name}` : name;
    if (mode === 'pods') {
      const ep = endpoints.get(`${svcNs}/${name}`);
      const instances = [];
      for (const subset of (ep && ep.subsets) || []) {
        // The endpoint port with the Service port's name (its target port on the pods), or the only one.
        const epPort = (subset.ports || []).find((x) => (x.name || '') === (port.name || '')) || (subset.ports || [])[0];
        if (!epPort) continue;
        const inst = (a, healthy) => ({ id: (a.targetRef && a.targetRef.name) || a.hostname || a.ip, url: hostPort(scheme, a.ip, epPort.port), healthy });
        instances.push(...(subset.addresses || []).map((a) => inst(a, true)), ...(subset.notReadyAddresses || []).map((a) => inst(a, false)));
      }
      const ready = instances.find((i) => i.healthy);
      if (!ready) { warnings.push(`${name}: no ready pods`); continue; }
      services.push({ name: svcName, url: ready.url, instances });
      continue;
    }
    if (mode === 'external') {
      const ing = ((svc.status && svc.status.loadBalancer && svc.status.loadBalancer.ingress) || [])[0];
      host = ing && (ing.hostname || ing.ip);
      if (!host && svc.spec.externalIPs && svc.spec.externalIPs[0]) host = svc.spec.externalIPs[0];
      if (!host) { warnings.push(`${name}: no external address (not a LoadBalancer?)`); continue; }
    } else if (mode === 'cluster-ip') {
      host = svc.spec.clusterIP;
      if (!host || host === 'None') { warnings.push(`${name}: headless service has no cluster IP`); continue; }
    } else {
      host = `${name}.${svcNs}.svc.cluster.local`;
    }
    services.push({ name: svcName, url: hostPort(scheme, host, p), instances: [{ id: name, url: hostPort(scheme, host, p), healthy: true }] });
  }
  return { services, warnings };
}

const authorization = (token) => (token ? [['Authorization', /^(basic|bearer) /i.test(token) ? token : `Bearer ${token}`]] : []);
const isOpenApi = (doc) => !!(doc && typeof doc === 'object' && (doc.openapi || doc.swagger) && doc.paths);

async function discoverJson(cfg, settings) {
  const json = await fetchJson(cfg.url, cfg, settings, authorization(cfg.token));
  // An API description is not a list of services; reading it as one makes nonsense variables
  // (an OpenAPI document's "openapi": "3.1.0" became openapi_url = 3.1.0). Say what to do instead.
  if (!cfg.listPath && json && typeof json === 'object') {
    if (isOpenApi(json)) {
      throw new DiscoveryError('This URL is an OpenAPI document, not a list of services. Choose the registry type "OpenAPI document" '
        + 'to get its base URL as a variable and a request for every operation, kept up to date.');
    }
    if (json.info && Array.isArray(json.item)) {
      throw new DiscoveryError('This URL is a Postman collection, not a list of services. '
        + 'To get its requests, use Import → "or import from a link" with this URL and token.');
    }
  }
  let list = cfg.listPath ? getPath(json, cfg.listPath) : json;
  if (list === undefined) throw new DiscoveryError(`Nothing found at "${cfg.listPath}" in the response`);
  const nameField = cfg.nameField || 'name';
  const urlField = cfg.urlField || 'url';
  const urlOf = (item) => {
    if (typeof item === 'string') return item;
    if (urlField.includes('{')) {
      let missing = false;
      const out = urlField.replace(/\{([^}]+)\}/g, (m, path) => {
        const v = getPath(item, path.trim());
        if (v === undefined || v === null) missing = true;
        return v === undefined || v === null ? '' : String(v);
      });
      return missing ? undefined : out;
    }
    return getPath(item, urlField);
  };
  // An object map ({ "orders": "http://..." } or { "orders": { "url": "..." } }) becomes a list keyed by name.
  let entries;
  if (Array.isArray(list)) entries = list.map((item) => ({ name: getPath(item, nameField), url: urlOf(item) }));
  else if (list && typeof list === 'object') entries = Object.entries(list).map(([name, v]) => ({ name, url: urlOf(v) }));
  else throw new DiscoveryError('Expected a list or an object of services. Set "List path" to the array inside the response.');
  const services = [];
  const warnings = [];
  for (const { name, url } of entries) {
    if (!name || !url) { warnings.push(`Skipped an entry without "${nameField}" or "${urlField}"`); continue; }
    services.push({ name: String(name), url: String(url).replace(/\/+$/, ''), instances: [{ url: String(url), healthy: true }] });
  }
  return { services, warnings };
}

// Where the API is: the first server (with its variables' defaults), resolved against the
// document's own URL when it's relative ("/api/v1"), as the OpenAPI spec says. Swagger 2 has host
// and basePath instead, defaulting to the document's host and scheme.
function serverUrl(doc, docUrl) {
  let server;
  if (doc.swagger) {
    const at = new URL(docUrl);
    const scheme = (doc.schemes && doc.schemes[0]) || at.protocol.replace(':', '');
    server = `${scheme}://${doc.host || at.host}${doc.basePath || ''}`;
  } else {
    const s = (doc.servers && doc.servers[0]) || { url: '/' };
    server = String(s.url || '/');
    for (const [k, v] of Object.entries(s.variables || {})) server = server.split(`{${k}}`).join(v && v.default != null ? v.default : '');
    try { server = new URL(server, docUrl).href; } catch { /* a template we can't resolve: leave it as written */ }
  }
  return server.replace(/\/+$/, '');
}

async function discoverOpenApi(cfg, settings) {
  const doc = await fetchJson(cfg.url, cfg, settings, authorization(cfg.token),
    { parse: parseDocument, accept: 'application/json, application/yaml;q=0.9, */*;q=0.8', what: 'JSON or YAML' });
  if (!isOpenApi(doc)) throw new DiscoveryError('This URL is not an OpenAPI (Swagger) document: it has no "openapi" or "swagger" version with "paths".');
  const url = String(cfg.baseUrl || '').trim().replace(/\/+$/, '') || serverUrl(doc, cfg.url);
  const name = String(cfg.serviceName || '').trim() || (doc.info && doc.info.title) || 'api';
  const warnings = [];
  if (!cfg.baseUrl && !doc.swagger && !(doc.servers && doc.servers.length)) warnings.push('The document lists no servers, so its own address is used as the base URL.');
  return { services: [{ name, url, instances: [{ url, healthy: true }] }], warnings, document: doc };
}

const PROVIDERS = { consul: discoverConsul, eureka: discoverEureka, kubernetes: discoverKubernetes, json: discoverJson, openapi: discoverOpenApi };

async function discover(cfg, settings) {
  if (!cfg || !PROVIDERS[cfg.provider]) throw new DiscoveryError(`Unknown discovery provider "${cfg && cfg.provider}"`);
  if (!cfg.url) throw new DiscoveryError('Enter the registry URL');
  const found = await PROVIDERS[cfg.provider](cfg, settings);
  found.services.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

// ---- Environment sync --------------------------------------------------------------------

function variableName(pattern, serviceName) {
  const safe = String(serviceName).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'service';
  return (pattern || '{name}_url').replace(/\{name\}/g, safe).replace(/\{NAME\}/g, safe.toUpperCase());
}

/**
 * Updates environment values in place from discovered services.
 * Rows created by discovery are tagged { discovered: sourceId }. Re-syncing updates changed URLs,
 * adds new services, removes services that disappeared, and leaves every other row alone.
 * `extra` are further values the source provides, by their own names ([{ key, value }]).
 * Returns { added, updated, removed, unchanged } (variable names).
 */
function syncValues(values, services, { sourceId, variablePattern, keepMissing = false, extra = [] } = {}) {
  const diff = { added: [], updated: [], removed: [], unchanged: [] };
  const wanted = new Map();
  for (const s of services) wanted.set(variableName(variablePattern, s.name), s.url);
  for (const x of extra) wanted.set(x.key, x.value);
  for (const [key, url] of wanted) {
    const row = values.find((v) => v.key === key);
    if (!row) {
      values.push({ key, value: url, enabled: true, discovered: sourceId });
      diff.added.push(key);
    } else if (row.value !== url) {
      row.value = url;
      row.discovered = row.discovered || sourceId;
      diff.updated.push(key);
    } else diff.unchanged.push(key);
  }
  if (!keepMissing) {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v.discovered === sourceId && !wanted.has(v.key)) {
        diff.removed.push(v.key);
        values.splice(i, 1);
      }
    }
  }
  return diff;
}

/**
 * A service's OpenAPI document, JSON or YAML. Only a plain GET: the registry's token and headers
 * aren't sent to the services. Throws with e.unreachable when the service didn't answer at all.
 */
function fetchDocument(url, { verifySSL = true } = {}, settings = {}) {
  return fetchJson(url, { verifySSL, headers: [] }, { ...settings, timeout: Math.min((settings && settings.timeout) || 8000, 8000) },
    [], { parse: parseDocument, accept: 'application/json, application/yaml;q=0.9, */*;q=0.8', what: 'JSON or YAML' });
}

module.exports = { discover, syncValues, variableName, fetchDocument, DiscoveryError, PROVIDERS: Object.keys(PROVIDERS) };
