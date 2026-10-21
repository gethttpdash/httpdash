'use strict';

/**
 * WebSocket client (RFC 6455) on HttpDash's own HTTP stack, so the handshake gets the same headers,
 * auth, cookies, client certificates, trusted CAs and proxy as any other request.
 * No extensions are offered (compression is off), so frames are always plain.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { connectTunnel, socksConnect, tunnelFor, matchesBypass, RequestError } = require('./http-client');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 3000;
const CLOSE_REASONS = {
  1000: 'Normal closure', 1001: 'Going away', 1002: 'Protocol error', 1003: 'Unsupported data', 1005: 'No status code',
  1006: 'Connection lost', 1007: 'Invalid message data', 1008: 'Policy violation', 1009: 'Message too big',
  1010: 'Extension required', 1011: 'Server error', 1012: 'Service restart', 1013: 'Try again later', 1015: 'TLS handshake failed',
};
const utf8 = new TextDecoder('utf-8', { fatal: true });
const headerPairs = (raw) => { const out = []; for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]); return out; };

class WebSocketConnection extends EventEmitter {
  constructor(socket, handshake, maxMessageBytes = MAX_MESSAGE_BYTES) {
    super();
    this.socket = socket;
    this.handshake = handshake;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts, size } while a fragmented message arrives
    this.closeSent = false;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.receive(d));
    socket.on('close', () => this.finish(1006, ''));
    socket.on('error', (e) => this.emit('error', e));
  }

  get isOpen() { return !this.closed && !this.closeSent; }

  /** Sends a text message (string) or a binary one (Buffer). Returns the payload size in bytes. */
  send(data) {
    if (!this.isOpen) throw new Error('The connection is closed');
    const binary = Buffer.isBuffer(data);
    const payload = binary ? data : Buffer.from(String(data), 'utf8');
    this.frame(binary ? 0x2 : 0x1, payload);
    return payload.length;
  }

  ping(data = '') { if (this.isOpen) this.frame(0x9, Buffer.from(String(data))); }

  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.frame(0x8, payload);
    this.closeSent = true;
    // Wait briefly for the server's close frame, then drop the connection.
    this.closeTimer = setTimeout(() => this.finish(code, String(reason)), CLOSE_TIMEOUT_MS);
  }

  // Client frames are always masked (RFC 6455 section 5.3).
  frame(opcode, payload) {
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  protocolError(code, message) {
    this.emit('error', new Error(message));
    this.close(code, message);
    this.buffer = Buffer.alloc(0);
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2 && !this.closed) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.protocolError(1002, 'The server used an extension that was not agreed');
      if (b1 & 0x80) return this.protocolError(1002, 'The server sent a masked frame');
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this.protocolError(1009, 'Message too big');
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxMessageBytes) return this.protocolError(1009, 'Message too big');
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      this.handleFrame(fin, opcode, Buffer.from(payload));
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this.protocolError(1002, 'Invalid control frame');
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) {
          // Echo the close, then finish once it is written.
          const echo = Buffer.alloc(payload.length >= 2 ? 2 : 0);
          if (echo.length) echo.writeUInt16BE(code, 0);
          this.frame(0x8, echo);
          this.closeSent = true;
        }
        this.finish(code, reason);
        this.socket.end();
      } else if (opcode === 0x9) {
        this.frame(0xa, payload);
        this.emit('ping', payload);
      } else if (opcode === 0xa) {
        this.emit('pong', payload);
      } else return this.protocolError(1002, `Unknown control frame ${opcode}`);
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragments) return this.protocolError(1002, 'Unexpected continuation frame');
      this.fragments.parts.push(payload);
      this.fragments.size += payload.length;
      if (this.fragments.size > this.maxMessageBytes) return this.protocolError(1009, 'Message too big');
      if (fin) {
        const { opcode: first, parts } = this.fragments;
        this.fragments = null;
        this.deliver(first, Buffer.concat(parts));
      }
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) return this.protocolError(1002, `Unknown frame type ${opcode}`);
    if (this.fragments) return this.protocolError(1002, 'A new message started before the previous one ended');
    if (fin) this.deliver(opcode, payload);
    else this.fragments = { opcode, parts: [payload], size: payload.length };
  }

  deliver(opcode, payload) {
    if (opcode === 0x2) { this.emit('message', { data: payload, binary: true, size: payload.length }); return; }
    let text;
    try { text = utf8.decode(payload); } catch { this.protocolError(1007, 'The server sent text that is not valid UTF-8'); return; }
    this.emit('message', { data: text, binary: false, size: payload.length });
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.closeTimer);
    this.emit('close', { code, reason, label: CLOSE_REASONS[code] || '' });
    this.socket.destroy();
  }
}

/**
 * Opens a WebSocket. opts: { url (ws:// or wss://), headers: [[k, v]], protocols: [..], timeout,
 * verifySSL, proxy, tlsFor(url), maxMessageBytes }. Resolves with a WebSocketConnection once the
 * handshake succeeds; rejects with the server's response (status, headers, body) if it refuses.
 */
async function connect(opts) {
  const url = new URL(opts.url);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new RequestError(`WebSocket URLs start with ws:// or wss://, not ${url.protocol}//`, 'EPROTO');
  const secure = url.protocol === 'wss:';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString('base64');

  const headers = {};
  for (const [k, v] of opts.headers || []) if (k && !/^(connection|upgrade|sec-websocket-(key|version|extensions))$/i.test(k)) headers[k] = v;
  Object.assign(headers, { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' });
  if (opts.protocols && opts.protocols.length) headers['Sec-WebSocket-Protocol'] = opts.protocols.join(', ');

  const reqOpts = { method: 'GET', hostname, port, path: url.pathname + url.search, headers, agent: false, servername: hostname, rejectUnauthorized: opts.verifySSL !== false };
  if (secure && opts.tlsFor) {
    const t = opts.tlsFor(`https://${url.host}${url.pathname}`);
    if (t && t.secureContext) reqOpts.secureContext = t.secureContext;
  }
  // Through a tunnel when one carries this host (see tunnels.js), else through the proxy.
  let socks = null;
  try { socks = await tunnelFor(`${secure ? 'https' : 'http'}://${url.host}/`, { tunnelId: opts.tunnelId }); } catch (e) { throw new RequestError(e.message, 'ETUNNEL'); }
  if (socks) {
    const socket = await socksConnect(socks, { host: hostname, port }, opts.timeout || 30000);
    delete reqOpts.agent;
    reqOpts.createConnection = () => (secure
      ? tls.connect({ socket, servername: hostname, rejectUnauthorized: reqOpts.rejectUnauthorized, ...(reqOpts.secureContext ? { secureContext: reqOpts.secureContext } : {}) })
      : socket);
  }
  const proxy = !socks && opts.proxy && opts.proxy.enabled && opts.proxy.host ? opts.proxy : null;
  if (proxy && !matchesBypass(hostname, proxy.bypass)) {
    // A WebSocket stays open, so both ws:// and wss:// go through a CONNECT tunnel.
    const socket = await connectTunnel(proxy, { hostname, port }, opts.timeout || 0);
    delete reqOpts.agent;
    reqOpts.createConnection = () => (secure
      ? tls.connect({ socket, servername: hostname, rejectUnauthorized: reqOpts.rejectUnauthorized, ...(reqOpts.secureContext ? { secureContext: reqOpts.secureContext } : {}) })
      : socket);
  }

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = (secure ? https : http).request(reqOpts);
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new RequestError('The server answered with an invalid WebSocket handshake (Sec-WebSocket-Accept)', 'EWSHANDSHAKE'));
        return;
      }
      if (res.headers['sec-websocket-extensions']) {
        socket.destroy();
        reject(new RequestError(`The server turned on an extension HttpDash didn't ask for: ${res.headers['sec-websocket-extensions']}`, 'EWSHANDSHAKE'));
        return;
      }
      const conn = new WebSocketConnection(socket, {
        status: res.statusCode, statusText: res.statusMessage || 'Switching Protocols', headers: headerPairs(res.rawHeaders),
        protocol: res.headers['sec-websocket-protocol'] || '', time: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        sentHeaders: Object.entries(headers),
      }, opts.maxMessageBytes);
      resolve(conn);
      // Bytes that came with the handshake (often a greeting) are handled once the caller has had
      // a chance to attach listeners, so that first message isn't lost.
      if (head && head.length) setImmediate(() => conn.receive(head));
    });
    // A normal HTTP response means the server refused to upgrade; keep it so the user can see why.
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => reject(Object.assign(
        new RequestError(`The server refused the WebSocket connection: ${res.statusCode} ${res.statusMessage || ''}`.trim(), 'EWSREFUSED'),
        { status: res.statusCode, headers: headerPairs(res.rawHeaders), body: Buffer.concat(chunks).toString('utf8').slice(0, 4000) },
      )));
    });
    req.on('error', reject);
    if (opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(new RequestError('The WebSocket handshake timed out', 'ETIMEDOUT')));
    req.end();
  });
}

module.exports = { connect, WebSocketConnection, CLOSE_REASONS };
