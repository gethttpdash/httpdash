'use strict';

/**
 * An MCP server (Model Context Protocol, over stdio) for the HttpDash API: `httpdash mcp`.
 *
 * Every API operation (ai-api-spec.js) becomes a tool, its path, query and body fields flattened into
 * one input object. Calls go to the HttpDash app running on this computer, with the port and token it
 * keeps in ai-access.json (read on every call, so a new token or port is picked up). Screenshots come
 * back as images. Nothing is written to stdout but protocol messages.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { OPERATIONS } = require('./ai-api-spec');

const PROTOCOL = '2025-06-18';

/** Where the app keeps its data (Electron's userData for "httpdash"). */
function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.HTTPDASH_DATA_DIR) return env.HTTPDASH_DATA_DIR;
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'httpdash');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'httpdash');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'httpdash');
}

const NOT_RUNNING = 'HttpDash is not running, or AI access is off. Open HttpDash and turn on Settings → AI access.';

/** The tool for each operation: its input schema has the path, query and body fields side by side. */
function tools() {
  return OPERATIONS.map((op) => {
    const properties = {};
    const required = [];
    for (const p of op.parameters) {
      properties[p.name] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
      if (p.required) required.push(p.name);
    }
    if (op.id === 'takeScreenshot') delete properties.format;
    for (const [k, v] of Object.entries((op.body && op.body.properties) || {})) properties[k] = v;
    for (const k of (op.body && op.body.required) || []) required.push(k);
    return {
      name: op.id,
      title: op.summary,
      description: `${op.summary}.${op.description ? ` ${op.description}` : ''} Needs the "${op.permission}" permission in HttpDash.`,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      annotations: {
        title: op.summary,
        readOnlyHint: op.method === 'get',
        destructiveHint: op.method === 'delete',
        idempotentHint: op.method === 'get' || op.method === 'put',
        openWorldHint: op.permission === 'run',
      },
    };
  });
}

function request({ port, token, method, pathAndQuery, body, client }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method: method.toUpperCase(), path: pathAndQuery, timeout: 130000,
      headers: { Authorization: `Bearer ${token}`, 'X-Client-Name': client, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HttpDash did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * A server: handle(message) returns the reply to a JSON-RPC message (or null for a notification).
 * opts: { dataDir, version, access(): { port, token } (for tests) }
 */
function createServer({ dataDir = defaultDataDir(), version = '0.0.0', access } = {}) {
  let client = 'MCP';
  const readAccess = access || (() => JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-access.json'), 'utf8')));
  const byName = new Map(OPERATIONS.map((op) => [op.id, op]));

  async function callTool(name, args = {}) {
    const op = byName.get(name);
    if (!op) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
    let acc;
    try { acc = readAccess(); } catch { return { isError: true, content: [{ type: 'text', text: NOT_RUNNING }] }; }
    let p = op.path;
    const query = new URLSearchParams();
    const body = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (v === undefined || v === null) continue;
      const param = op.parameters.find((x) => x.name === k);
      if (param && param.in === 'path') p = p.replace(`{${k}}`, encodeURIComponent(String(v)));
      else if (param && param.in === 'query') query.set(k, String(v));
      else body[k] = v;
    }
    if (/\{\w+\}/.test(p)) return { isError: true, content: [{ type: 'text', text: `Missing ${p.match(/\{(\w+)\}/)[1]}` }] };
    if (name === 'takeScreenshot') query.set('format', 'base64');
    const qs = query.toString();
    let res;
    try {
      res = await request({ port: acc.port, token: acc.token, method: op.method, pathAndQuery: `${p}${qs ? `?${qs}` : ''}`, body: op.body ? body : null, client });
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.code === 'ECONNREFUSED' ? NOT_RUNNING : e.message }] };
    }
    if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: (res.json && res.json.error) || `${res.status}: ${res.text.slice(0, 500)}` }] };
    if (name === 'takeScreenshot' && res.json && res.json.base64) {
      return { content: [{ type: 'image', data: res.json.base64, mimeType: 'image/png' }, { type: 'text', text: `Screenshot, ${res.json.width}×${res.json.height} pixels` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.json, null, 2) }], structuredContent: res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : undefined };
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const info = (msg.params && msg.params.clientInfo) || {};
          // Header values are ASCII: the client's name is shown in HttpDash's access history.
          client = `MCP (${String(info.name || 'client').replace(/[^\x20-\x7e]/g, '')})`.slice(0, 80);
          return reply({
            protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'httpdash', title: 'HttpDash', version },
            instructions: 'HttpDash is the API client running on this computer. Start with getStatus, then listCollections or searchRequests. '
              + 'sendRequest sends a saved request; startRun runs the Runner (follow it with getRun). To see and use the screen: getUiSnapshot lists the visible '
              + 'controls with refs, uiAction acts on a ref, takeScreenshot shows it. The user sees every call in HttpDash and chooses what is allowed.',
          });
        }
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: tools() });
        case 'tools/call': return reply(await callTool(msg.params && msg.params.name, msg.params && msg.params.arguments));
        default:
          if (!isRequest) return null; // notifications such as notifications/initialized
          return error(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return isRequest ? error(-32603, e.message) : null;
    }
  }

  return { handle, tools, callTool };
}

/** Runs over stdio until stdin closes: one JSON-RPC message per line. */
function runStdio({ input = process.stdin, output = process.stdout, ...opts } = {}) {
  const server = createServer(opts);
  let buffer = '';
  const write = (m) => { if (m) output.write(`${JSON.stringify(m)}\n`); };
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
        const list = Array.isArray(msg) ? msg : [msg];
        Promise.all(list.map((m) => server.handle(m))).then((replies) => {
          const out = replies.filter(Boolean);
          if (Array.isArray(msg)) { if (out.length) write(out); } else write(out[0]);
        });
      }
    });
    input.on('end', resolve);
  });
}

module.exports = { createServer, runStdio, tools, defaultDataDir, request };
