'use strict';

/**
 * Collections from the services a registry found: for each discovered service, its OpenAPI document
 * is looked for at a few paths under the service's URL (such as /v3/api-docs), and becomes a
 * collection whose requests use the service's own variable ({{orders_url}}), so load balancing and
 * traffic by instance apply. Later syncs bring each collection in step with its document the same
 * way an OpenAPI document source does (openapi-sync.js): the user's edits are kept.
 *
 * Nothing is sent to the services but a plain GET for the document: the registry's token and
 * headers are for the registry, not for them.
 */
const openapiSync = require('./openapi-sync');
const requestShape = require('./request-shape');

const DEFAULT_PATHS = ['/v3/api-docs', '/v2/api-docs', '/openapi.json', '/swagger/v1/swagger.json', '/api-json'];
const CONCURRENCY = 6;

const isOpenApi = (doc) => !!(doc && typeof doc === 'object' && (doc.openapi || doc.swagger) && doc.paths);

/** The paths to try, from what the user wrote ("/v3/api-docs, /openapi.json"); the common ones when empty. */
function specPaths(text) {
  const list = String(text || '').split(/[\s,]+/).map((p) => p.trim()).filter(Boolean).map((p) => (/^https?:\/\//i.test(p) || p.startsWith('/') ? p : `/${p}`));
  return list.length ? list : DEFAULT_PATHS;
}

const joinUrl = (base, path) => (/^https?:\/\//i.test(path) ? path : `${String(base).replace(/\/+$/, '')}${path}`);

// Titles frameworks give a document when nobody named it, which would make every collection look alike.
const GENERIC_TITLE = /^(openapi definition|api|apis|swagger|swagger ui|api documentation|api docs|rest api|my api|sample api|title)$/i;
/** The collection's name: the document's title, or the service's name when the title says nothing. */
function collectionName(doc, serviceName) {
  const title = String((doc && doc.info && doc.info.title) || '').trim();
  return !title || GENERIC_TITLE.test(title) ? serviceName : title;
}

/**
 * Looks for a service's document: the first path that answers with an OpenAPI document wins. A path
 * that answers with something else (404, HTML) moves on to the next; a service that can't be reached
 * at all isn't tried again. fetchDoc(url) resolves to the parsed document or throws
 * (with e.unreachable when the service didn't answer).
 * Returns { doc, url } or { error, unreachable } when there is none.
 */
async function findSpec(baseUrl, paths, fetchDoc) {
  let last = 'no API document found';
  for (const p of paths) {
    const url = joinUrl(baseUrl, p);
    try {
      const doc = await fetchDoc(url);
      if (isOpenApi(doc)) return { doc, url };
      last = `${url} is not an OpenAPI document`;
    } catch (e) {
      if (e.unreachable) return { error: e.message, unreachable: true };
      last = e.message;
    }
  }
  return { error: paths.length > 1 ? `no API document at ${paths.join(', ')}` : last };
}

// Runs fn over items, a few at a time, keeping their order.
async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Syncs a collection for each service.
 *   services     [{ name, url, variable }] from the registry
 *   collections  { [serviceName]: collection } made by earlier syncs (copies: they are changed)
 *   paths        where to look for each document (see specPaths)
 *   update       false: leave existing collections alone and only create the missing ones
 *   fetchDoc     (url) => document (see findSpec)
 * Returns { specs, missing }:
 *   specs    one entry per service: { service, variable, status: 'synced' | 'unchanged' | 'skipped' |
 *            'none' | 'unreachable', docUrl, spec, operations, requests (mergeCollection's diff),
 *            shapes, collection, error }
 *   missing  services with a collection that the registry no longer lists
 */
async function syncServiceCollections({ services, collections = {}, paths, sourceId, update = true, fetchDoc }) {
  const specs = await eachLimited(services, CONCURRENCY, async (s) => {
    const base = { service: s.name, variable: s.variable };
    const existing = collections[s.name] || null;
    if (existing && !update) return { ...base, status: 'skipped' };
    const found = await findSpec(s.url, paths, fetchDoc);
    if (!found.doc) return { ...base, status: found.unreachable ? 'unreachable' : 'none', error: found.error };
    const generated = openapiSync.buildCollection(found.doc, { variable: s.variable });
    generated.name = collectionName(found.doc, s.name);
    const merged = openapiSync.mergeCollection(existing, generated, { sourceId: `${sourceId}:${s.name}` });
    merged.collection.discoveredService = { sourceId, service: s.name };
    const unchanged = !!existing && merged.diff.spec.unchanged && !merged.diff.changes.length && !merged.diff.collection.length;
    return {
      ...base, status: unchanged ? 'unchanged' : 'synced', docUrl: found.url, spec: generated.openapi.spec,
      operations: openapiSync.operations(merged.collection).length, requests: merged.diff,
      shapes: requestShape.shapesOf(found.doc), collection: merged.collection,
    };
  });
  const listed = new Set(services.map((s) => s.name));
  const missing = Object.keys(collections).filter((name) => !listed.has(name));
  return { specs, missing };
}

module.exports = { syncServiceCollections, findSpec, specPaths, collectionName, DEFAULT_PATHS };
