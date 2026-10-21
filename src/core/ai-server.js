'use strict';

/**
 * The local HTTP server for the HttpDash API (see ai-api-spec.js), used by AI agents and scripts.
 *
 * It listens on 127.0.0.1 only and answers only requests that:
 *   - name a local Host (127.0.0.1, localhost, [::1]) and carry no Origin header, so a web page
 *     (or DNS rebinding) can't reach it from a browser;
 *   - carry the token (Authorization: Bearer ...), compared in constant time;
 *   - arrive while HttpDash is unlocked and AI access isn't paused;
 *   - use an operation whose permission the user allowed.
 * /openapi.json is served without the token, so an agent can learn the API first.
 *
 * The token and port are kept in ai-access.json (readable by the user only), where the MCP bridge
 * finds them. Every call is kept in a short history and reported through onActivity.
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { route, openApiDocument } = require('./ai-api-spec');

const DEFAULT_PORT = 47823;
const MAX_BODY = 1024 * 1024;
const HISTORY = 500;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class AiServer {
  /**
   * opts: { file, version, isLocked(), call(opId, args, ctx) -> result (the window's handlers),
   *         main: { [opId]: (args, ctx) -> result } (handled here), audit, onActivity(event) }
   */
  constructor(opts) {
    this.opts = opts;
    this.config = { enabled: false, port: DEFAULT_PORT, permissions: { read: true }, paused: false };
    this.server = null;
    this.history = [];
    this.inFlight = 0;
    this.lastCallAt = 0;
    this.listenError = null;
  }

  // ---- Token and port -------------------------------------------------------------------------

  loadAccess() {
    try {
      const a = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'));
      if (a && typeof a.token === 'string' && a.token.length >= 32) return a;
    } catch { /* first use */ }
    return this.writeAccess({ token: crypto.randomBytes(32).toString('base64url') });
  }

  writeAccess(access) {
    const out = { token: access.token, port: this.config.port, url: `http://127.0.0.1:${this.config.port}` };
    fs.writeFileSync(this.opts.file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.opts.file, 0o600); } catch { /* not on every platform */ }
    return out;
  }

  token() { return this.loadAccess().token; }

  /** A new token: whoever had the old one is locked out. */
  regenerateToken() {
    const access = this.writeAccess({ token: crypto.randomBytes(32).toString('base64url') });
    this.record({ op: 'tokenRegenerated', method: '-', path: '-', permission: '-', status: 200, ms: 0, client: 'HttpDash' });
    return access.token;
  }

  // ---- Configuration --------------------------------------------------------------------------

  /** cfg: { enabled, port, permissions: { read, run, edit, ui, secrets }, paused } */
  async configure(cfg) {
    const before = this.config;
    this.config = {
      enabled: !!cfg.enabled,
      port: Number(cfg.port) > 0 && Number(cfg.port) < 65536 ? Number(cfg.port) : DEFAULT_PORT,
      permissions: { read: true, ...(cfg.permissions || {}) },
      paused: !!cfg.paused,
    };
    if (!this.config.enabled) { await this.stop(); return this.status(); }
    if (this.server && before.port === this.config.port) { this.writeAccess(this.loadAccess()); return this.status(); }
    await this.stop();
    await this.start();
    return this.status();
  }

  start() {
    this.writeAccess(this.loadAccess());
    this.listenError = null;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (e) => { this.listenError = e.code === 'EADDRINUSE' ? `Port ${this.config.port} is in use` : e.message; this.server = null; resolve(); });
      server.listen(this.config.port, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });
  }

  status() {
    return {
      enabled: this.config.enabled, listening: !!this.server, port: this.config.port, url: `http://127.0.0.1:${this.config.port}`,
      paused: this.config.paused, permissions: this.config.permissions, error: this.listenError,
      active: this.inFlight > 0, lastCallAt: this.lastCallAt, calls: this.history.length,
    };
  }

  // ---- History --------------------------------------------------------------------------------

  record(entry) {
    const e = { time: Date.now(), ...entry };
    this.history.push(e);
    if (this.history.length > HISTORY) this.history.shift();
    if (this.opts.onActivity) this.opts.onActivity({ type: 'call', entry: e, status: this.status() });
    return e;
  }

  log(limit = 50) { return this.history.slice(-Math.min(Math.max(1, Number(limit) || 50), HISTORY)).reverse(); }

  // ---- Requests -------------------------------------------------------------------------------

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    const client = String(req.headers['x-client-name'] || req.headers['user-agent'] || 'unknown').slice(0, 80);
    const send = (status, body, type = 'application/json') => {
      const data = type === 'application/json' ? JSON.stringify(body, null, 2) : body;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    };
    let entry = { op: null, method: req.method, path: url.pathname, permission: null, client };
    try {
      if (!LOCAL_HOST.test(req.headers.host || '')) throw new HttpError(403, 'Only local requests are answered');
      if (req.headers.origin) throw new HttpError(403, 'Browsers are not allowed to call this API');
      if (req.method === 'GET' && (url.pathname === '/openapi.json' || url.pathname === '/')) {
        const doc = openApiDocument({ version: this.opts.version, port: this.config.port });
        return send(200, url.pathname === '/' ? { name: 'HttpDash API', openapi: `${this.status().url}/openapi.json`, auth: 'Authorization: Bearer <token from Settings → AI access>' } : doc);
      }
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const expected = Buffer.from(this.token());
      const given = Buffer.from(auth ? auth[1].trim() : '');
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Missing or wrong token (Settings → AI access in HttpDash)');
      if (this.opts.isLocked && this.opts.isLocked()) throw new HttpError(423, 'HttpDash is locked');
      if (this.config.paused) throw new HttpError(503, 'AI access is paused in HttpDash');
      const found = route(req.method, url.pathname);
      if (!found) throw new HttpError(404, `No operation for ${req.method} ${url.pathname}; see /openapi.json`);
      const { op, params } = found;
      entry = { ...entry, op: op.id, permission: op.permission };
      if (!this.config.permissions[op.permission]) {
        throw new HttpError(403, `This needs the "${op.permission}" permission, which is off in HttpDash (Settings → AI access)`);
      }
      const query = {};
      for (const p of op.parameters.filter((x) => x.in === 'query')) {
        if (!url.searchParams.has(p.name)) continue;
        const v = url.searchParams.get(p.name);
        query[p.name] = p.schema.type === 'integer' || p.schema.type === 'number' ? Number(v) : p.schema.type === 'boolean' ? v !== 'false' && v !== '0' : v;
      }
      const body = op.body ? await readJson(req) : {};
      this.inFlight++;
      this.lastCallAt = Date.now();
      if (this.opts.onActivity) this.opts.onActivity({ type: 'start', op: op.id, status: this.status() });
      let result;
      try {
        const ctx = { permissions: this.config.permissions, client };
        const args = { ...params, ...query, body };
        result = op.target === 'main' ? await this.opts.main[op.id](args, ctx) : await this.opts.call(op.id, args, ctx);
      } finally {
        this.inFlight--;
      }
      if (result && Buffer.isBuffer(result.png)) {
        if (query.format === 'base64') send(200, { base64: result.png.toString('base64'), width: result.width, height: result.height });
        else send(200, result.png, 'image/png');
      } else send(200, result === undefined ? { ok: true } : result);
      this.record({ ...entry, status: 200, ms: Date.now() - started, summary: summarize(result) });
      if (this.opts.audit && op.permission !== 'read' && op.permission !== 'ui') this.opts.audit.append('ai.call', { op: op.id, client, status: 200 });
    } catch (e) {
      const status = e.status || 500;
      send(status, { error: e.message || String(e) });
      if (status !== 403 || entry.op) this.record({ ...entry, status, ms: Date.now() - started, error: e.message });
      if (this.opts.audit && status >= 401 && status !== 404) this.opts.audit.append('ai.refused', { op: entry.op, path: entry.path, client, status });
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body over 1 MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch { reject(new HttpError(400, 'The body must be a JSON object')); }
    });
    req.on('error', reject);
  });
}

// A few words about a result, for the access history.
function summarize(r) {
  if (!r || typeof r !== 'object') return '';
  if (Buffer.isBuffer(r.png)) return `screenshot ${r.width}×${r.height}`;
  if (r.response && r.response.status) return `${r.response.status}${r.response.time != null ? ` in ${r.response.time} ms` : ''}`;
  if (r.runId) return `run ${r.state || ''}`.trim();
  if (Array.isArray(r.items)) return `${r.items.length} items`;
  if (Array.isArray(r.collections)) return `${r.collections.length} collections`;
  if (Array.isArray(r.elements)) return `${r.elements.length} elements`;
  return '';
}

module.exports = { AiServer, HttpError, DEFAULT_PORT };
