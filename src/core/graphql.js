'use strict';

/**
 * GraphQL beyond sending a query: which operations a document holds (so one can be picked by
 * name), and subscriptions over a WebSocket. Both "graphql-transport-ws" (the graphql-ws library)
 * and the older "graphql-ws" protocol of subscriptions-transport-ws are spoken; the server picks.
 */
const websocket = require('./websocket');

/**
 * The operations in a GraphQL document, in order: [{ type: 'query'|'mutation'|'subscription', name }].
 * A tokenizer, not a parser: it skips strings, block strings and comments, and reads what starts
 * each top-level definition. An anonymous "{ ... }" is a query; fragments aren't operations.
 */
function operations(source) {
  const s = String(source || '');
  const out = [];
  let depth = 0;
  let i = 0;
  const word = /[_A-Za-z][_0-9A-Za-z]*/y;
  const readWord = () => { word.lastIndex = i; const m = word.exec(s); if (!m) return null; i = word.lastIndex; return m[0]; };
  const skipSpace = () => {
    for (;;) {
      while (i < s.length && /[\s,﻿]/.test(s[i])) i++;
      if (s[i] !== '#') return;
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '#') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '"') {
      if (s.startsWith('"""', i)) {
        i += 3;
        while (i < s.length && !s.startsWith('"""', i)) i += s[i] === '\\' && s.startsWith('"""', i + 1) ? 4 : 1;
        i += 3;
      } else {
        i++;
        while (i < s.length && s[i] !== '"' && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
        i++;
      }
      continue;
    }
    if (c === '{') {
      if (depth === 0) out.push({ type: 'query', name: null });
      depth++; i++; continue;
    }
    if (c === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && /[_A-Za-z]/.test(c)) {
      const w = readWord();
      if (w === 'query' || w === 'mutation' || w === 'subscription') {
        skipSpace();
        const name = /[_A-Za-z]/.test(s[i] || '') ? readWord() : null;
        out.push({ type: w, name });
        // Skip to the selection set, past variables and directives, so its "{" isn't another query.
        let paren = 0;
        while (i < s.length && !(s[i] === '{' && paren === 0)) {
          if (s[i] === '(') paren++;
          else if (s[i] === ')') paren--;
          else if (s[i] === '"') { i++; while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1; }
          i++;
        }
        if (i < s.length) { depth++; i++; }
      } else if (w === 'fragment') {
        while (i < s.length && s[i] !== '{') i++;
        if (i < s.length) { depth++; i++; }
      }
      continue;
    }
    i++;
  }
  return out;
}

/** The operation a request runs: the one named, or the only one; null when that's ambiguous. */
function selectedOperation(source, operationName) {
  const ops = operations(source);
  if (operationName) return ops.find((o) => o.name === operationName) || null;
  return ops.length === 1 ? ops[0] : null;
}

const isSubscription = (source, operationName) => {
  const op = selectedOperation(source, operationName);
  return !!op && op.type === 'subscription';
};

/**
 * Runs a subscription over a WebSocket until the server completes it, it fails, `signal` aborts
 * or a limit is reached. opts: { url (http(s) or ws(s)), headers: [[k, v]], payload: { query,
 * variables, operationName }, connectionParams, timeout (for the handshake and acknowledgement),
 * maxEvents, maxMs, signal, onEvent(event), ...websocket.connect options (verifySSL, proxy,
 * tunnelId, tlsFor) }.
 * Each result arrives as an event { event: 'next'|'error'|'complete', data (JSON text), id, t }.
 * Resolves with what an HTTP request resolves with, so it shows as a response: the handshake's
 * status and headers, and a body that is the JSON array of every payload received.
 */
async function subscribe(opts) {
  const wsUrl = String(opts.url).replace(/^http(s?):/i, 'ws$1:');
  const started = Date.now();
  const sentHeaders = (opts.headers || []).filter(([k]) => !/^(content-type|content-length|accept-encoding)$/i.test(k));
  const conn = await websocket.connect({
    ...opts,
    url: wsUrl,
    headers: sentHeaders,
    protocols: ['graphql-transport-ws', 'graphql-ws'],
    timeout: opts.timeout || 30000,
  });
  const legacy = conn.handshake.protocol === 'graphql-ws';
  const payloads = [];
  let firstByte = null;

  return new Promise((resolve) => {
    let done = false;
    let acked = false;
    let closeInfo = null;
    const timers = [];
    const send = (msg) => { try { conn.send(JSON.stringify(msg)); } catch { /* closed meanwhile */ } };
    const emit = (event, data) => {
      const ev = { event, data: typeof data === 'string' ? data : JSON.stringify(data), id: '1', t: Date.now() - started };
      if (opts.onEvent) opts.onEvent(ev);
    };
    const finish = ({ cancelled = false, error = null } = {}) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (conn.isOpen) {
        if (acked) send(legacy ? { id: '1', type: 'stop' } : { id: '1', type: 'complete' });
        conn.close(1000, 'Done');
      }
      const body = Buffer.from(JSON.stringify(payloads, null, 2));
      const total = Date.now() - started;
      resolve({
        status: conn.handshake.status,
        statusText: conn.handshake.statusText,
        httpVersion: '1.1',
        headers: conn.handshake.headers,
        body,
        rawSize: body.length,
        headersSize: 0,
        timings: { firstByte: firstByte != null ? firstByte : total, download: 0, total },
        url: wsUrl,
        redirects: [],
        cancelled,
        subscription: { protocol: conn.handshake.protocol || 'graphql-transport-ws', events: payloads.length, ...(closeInfo ? { closed: closeInfo } : {}), ...(error ? { error } : {}) },
      });
    };
    const onAbort = () => finish({ cancelled: true });
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort);
    }
    if (opts.maxMs) timers.push(setTimeout(() => finish(), opts.maxMs));
    timers.push(setTimeout(() => {
      if (!acked) { emit('error', { message: 'The server did not acknowledge the connection' }); finish({ error: 'The server did not acknowledge the connection' }); }
    }, opts.timeout || 30000));

    conn.on('message', (m) => {
      if (m.binary) return;
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (firstByte == null) firstByte = Date.now() - started;
      switch (msg.type) {
        case 'connection_ack':
          acked = true;
          send(legacy ? { id: '1', type: 'start', payload: opts.payload } : { id: '1', type: 'subscribe', payload: opts.payload });
          break;
        case 'ping': send({ type: 'pong', ...(msg.payload ? { payload: msg.payload } : {}) }); break;
        case 'ka': case 'pong': break;
        case 'next': case 'data':
          payloads.push(msg.payload);
          emit('next', msg.payload);
          if (opts.maxEvents && payloads.length >= opts.maxEvents) finish();
          break;
        case 'error': case 'connection_error': {
          const errors = msg.payload;
          payloads.push({ errors: Array.isArray(errors) ? errors : [errors] });
          emit('error', errors);
          finish({ error: Array.isArray(errors) && errors[0] && errors[0].message ? errors[0].message : 'The subscription failed' });
          break;
        }
        case 'complete':
          emit('complete', {});
          finish();
          break;
        default: break;
      }
    });
    conn.on('close', (c) => {
      closeInfo = { code: c.code, reason: c.reason || c.label };
      if (!done) {
        // graphql-ws closes with 4xxx codes for protocol errors (4401 Unauthorized, 4400 bad request...).
        const message = c.code >= 4000 ? `The server closed the subscription: ${c.code} ${c.reason || ''}`.trim() : null;
        if (message) emit('error', { message });
        finish(message ? { error: message } : {});
      }
    });
    conn.on('error', () => { /* a close follows */ });
    send({ type: 'connection_init', payload: opts.connectionParams || {} });
  });
}

module.exports = { operations, selectedOperation, isSubscription, subscribe };
