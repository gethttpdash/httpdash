'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// ---- Connection reuse ------------------------------------------------------------------------
//
// Connections are kept open and reused (keep-alive), as browsers do: a request to a host that was
// just called skips DNS, TCP and, above all, the TLS handshake, which on real HTTPS APIs costs more
// than everything else a request does. Node's pool tells connections apart by host, port, server
// name and certificate checking, but not by TLS context, so each client certificate / CA setup
// (a cached secure context) gets its own pool, and a connection is never reused with another
// certificate. Idle connections don't keep the process alive and are closed after a few seconds,
// or sooner when the server says so (Keep-Alive: timeout=...).
const AGENT_OPTIONS = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 64, maxFreeSockets: 32, timeout: 4000 };
const httpAgent = new http.Agent(AGENT_OPTIONS);
const httpsAgent = new https.Agent(AGENT_OPTIONS);
const tlsAgents = new WeakMap(); // secure context -> https.Agent

function agentFor(isHttps, secureContext) {
  if (!isHttps) return httpAgent;
  if (!secureContext) return httpsAgent;
  let agent = tlsAgents.get(secureContext);
  if (!agent) { agent = new https.Agent(AGENT_OPTIONS); tlsAgents.set(secureContext, agent); }
  return agent;
}

// A server may close an idle connection just as it is reused; nothing reached it, so browsers retry
// such a request once on a new connection.
const STALE_SOCKET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

/** Closes every idle kept-alive connection (e.g. before quitting, or when settings change). */
function closeIdleConnections() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

class RequestError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // Fall through and return the raw bytes if the server lied about the encoding.
  }
  return buffer;
}

// Opens a CONNECT tunnel through an HTTP proxy for HTTPS targets.
function connectTunnel(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${target.hostname}:${target.port}` };
    if (proxy.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
      headers,
      timeout,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new RequestError(`Proxy CONNECT failed with status ${res.statusCode}`, 'EPROXY'));
      } else resolve(socket);
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new RequestError('Proxy connection timed out', 'ETIMEDOUT')));
    req.end();
  });
}

/**
 * Performs a single HTTP exchange (no redirect handling).
 * opts: { method, url, headers: [[k, v]], body: Buffer|null, timeout, verifySSL, proxy,
 *         tlsFor(url) -> { secureContext, label } | null (client and CA certificates),
 *         reuseConnections (default true),
 *         connectTo: { host, address, family } to connect to that address for that host, keeping the
 *         host name for the Host header, SNI and the certificate check (Compare instances, by DNS) }
 */
async function exchange(opts) {
  try {
    return await exchangeOnce(opts);
  } catch (e) {
    if (e.staleSocket && !(opts.signal && opts.signal.aborted)) return exchangeOnce({ ...opts, reuseConnections: false });
    throw e;
  }
}

async function exchangeOnce(opts) {
  const url = new URL(opts.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestError(`Unsupported protocol ${url.protocol}`, 'EPROTO');
  }
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port || (isHttps ? 443 : 80);

  const headers = {};
  for (const [k, v] of opts.headers || []) {
    if (!k) continue;
    if (headers[k] !== undefined) headers[k] = [].concat(headers[k], v);
    else headers[k] = v;
  }

  const reqOpts = {
    method: opts.method,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    path: url.pathname + url.search,
    headers,
    rejectUnauthorized: opts.verifySSL !== false,
    servername: url.hostname,
  };
  // Client certificates and extra CAs come as a ready-made (cached) TLS context.
  const tlsOpts = isHttps && opts.tlsFor ? opts.tlsFor(url.href) : null;
  const tlsExtra = tlsOpts && tlsOpts.secureContext ? { secureContext: tlsOpts.secureContext } : {};
  Object.assign(reqOpts, tlsExtra);
  reqOpts.agent = opts.reuseConnections === false ? false : agentFor(isHttps, tlsExtra.secureContext);
  // Connect to one given address of the host. A pooled connection could be to another address of
  // the same host, so these never use the pool.
  const pin = opts.connectTo && opts.connectTo.host === url.hostname ? opts.connectTo : null;
  if (pin) {
    reqOpts.agent = false;
    reqOpts.lookup = (hostname, o, cb) => (o && o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family));
  }

  const proxy = opts.proxy && opts.proxy.enabled && opts.proxy.host ? opts.proxy : null;
  if (proxy && !matchesBypass(url.hostname, proxy.bypass)) {
    if (pin) throw new RequestError('A proxy picks the address of the host itself, so one address cannot be chosen', 'EPROXYPIN');
    if (isHttps) {
      const socket = await connectTunnel(proxy, { hostname: reqOpts.hostname, port }, opts.timeout || 0);
      // Without an agent, Node uses createConnection to obtain the socket for this request.
      delete reqOpts.agent;
      reqOpts.createConnection = () => require('tls').connect({
        socket,
        servername: url.hostname,
        rejectUnauthorized: reqOpts.rejectUnauthorized,
        ...tlsExtra,
      });
    } else {
      reqOpts.hostname = proxy.host;
      reqOpts.port = proxy.port || 8080;
      reqOpts.path = url.href;
      if (proxy.username) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      }
    }
  }

  // Only pooled connections can be reused (a proxy tunnel's TLS socket is new, though already connected).
  const pooled = !!reqOpts.agent;
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const timings = { start: Date.now() };
    let settled = false;
    let reused = false;
    let answered = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Failed on a reused connection before any answer: the server had closed it (see exchange).
      if (reused && !answered && err && STALE_SOCKET.has(err.code)) err.staleSocket = true;
      reject(err);
    };

    // Set once a streamed response has started, so stopping it can still return what arrived.
    let finishPartial = null;
    const req = lib.request(reqOpts, (res) => {
      answered = true;
      timings.firstByte = ms();
      const chunks = [];
      let rawSize = 0;
      // Streams (text/event-stream) are handed to opts.onData as they arrive, unless compressed.
      const streaming = opts.onData && /^\s*text\/event-stream\b/i.test(res.headers['content-type'] || '') && !res.headers['content-encoding'];
      res.on('data', (c) => {
        chunks.push(c);
        rawSize += c.length;
        if (opts.maxSize && rawSize > opts.maxSize) {
          req.destroy(new RequestError(`Response exceeded maximum size of ${opts.maxSize} bytes`, 'EMAXSIZE'));
          return;
        }
        if (streaming) {
          try { opts.onData(c); } catch (e) { req.destroy(e); }
        }
      });
      const finish = (cancelled) => {
        if (settled) return;
        timings.end = ms();
        const raw = Buffer.concat(chunks);
        const body = decompress(raw, res.headers['content-encoding']);
        const headerPairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) headerPairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        settled = true;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || '',
          httpVersion: res.httpVersion,
          headers: headerPairs,
          body,
          rawSize,
          headersSize: headerPairs.reduce((n, [k, v]) => n + k.length + String(v).length + 4, 0),
          timings: {
            dns: timings.dns,
            connect: timings.connect,
            tls: timings.tls,
            firstByte: timings.firstByte,
            download: timings.end - timings.firstByte,
            total: timings.end,
            ...(reused ? { reused: true } : {}),
          },
          remoteAddress: res.socket && res.socket.remoteAddress,
          clientCertificate: tlsOpts && tlsOpts.label ? tlsOpts.label : null,
          ...(cancelled ? { cancelled: true } : {}),
        });
      };
      if (streaming) finishPartial = () => finish(true);
      res.on('end', () => finish(false));
      res.on('error', fail);
    });

    req.on('socket', (socket) => {
      // A kept-alive connection is already open: no DNS, TCP or TLS step, and no listeners to add
      // to a socket that outlives this request.
      if (pooled && !socket.connecting && !socket.pending) { reused = true; return; }
      socket.once('lookup', () => { timings.dns = ms(); });
      socket.once('connect', () => { timings.connect = ms(); });
      socket.once('secureConnect', () => { timings.tls = ms(); });
    });
    if (opts.timeout) {
      req.setTimeout(opts.timeout, () => req.destroy(new RequestError(`Request timed out after ${opts.timeout} ms`, 'ETIMEDOUT')));
    }
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new RequestError('Request cancelled', 'ECANCELLED'));
      opts.signal.addEventListener('abort', () => {
        // Stopping a stream keeps what has arrived; anything else is cancelled.
        if (finishPartial) finishPartial();
        req.destroy(new RequestError('Request cancelled', 'ECANCELLED'));
      }, { once: true });
    }
    req.on('error', fail);
    if (opts.body && opts.body.length) req.write(opts.body);
    req.end();
  });
}

function matchesBypass(host, bypass) {
  if (!bypass) return false;
  return String(bypass).split(',').map((s) => s.trim()).filter(Boolean).some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

/**
 * Sends a request, following redirects if requested.
 * onHop(response, url) is called for each intermediate response so the caller can store cookies.
 */
async function send(opts, onHop) {
  let current = { ...opts };
  const redirects = [];
  const maxRedirects = opts.maxRedirects == null ? 10 : opts.maxRedirects;
  for (;;) {
    const res = await exchange(current);
    res.url = current.url;
    if (onHop) await onHop(res, current.url);
    const location = res.headers.find(([k]) => k.toLowerCase() === 'location');
    if (!opts.followRedirects || !REDIRECT_CODES.has(res.status) || !location) {
      res.redirects = redirects;
      return res;
    }
    if (redirects.length >= maxRedirects) throw new RequestError(`Exceeded maximum of ${maxRedirects} redirects`, 'EREDIRECTS');
    const nextUrl = new URL(location[1], current.url).href;
    redirects.push({ status: res.status, from: current.url, to: nextUrl });
    const changeToGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST');
    const sameOrigin = new URL(nextUrl).origin === new URL(current.url).origin;
    let headers = current.headers.filter(([k]) => k.toLowerCase() !== 'cookie' && k.toLowerCase() !== 'host');
    if (changeToGet) headers = headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
    if (!sameOrigin) headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
    current = {
      ...current,
      url: nextUrl,
      method: changeToGet ? 'GET' : current.method,
      body: changeToGet ? null : current.body,
      headers,
    };
    if (opts.cookieHeaderFor) {
      const cookie = opts.cookieHeaderFor(nextUrl);
      if (cookie) current.headers.push(['Cookie', cookie]);
    }
  }
}

module.exports = { send, exchange, RequestError, decompress, connectTunnel, matchesBypass, closeIdleConnections };
