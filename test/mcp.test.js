'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiServer } = require('../src/core/ai-server');
const { createServer } = require('../src/core/mcp');
const { OPERATIONS } = require('../src/core/ai-api-spec');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-mcp-'));
const seen = [];
const api = new AiServer({
  file: path.join(dir, 'ai-access.json'), version: '1.0.0', isLocked: () => false,
  call: async (op, args, ctx) => { seen.push({ op, args, client: ctx.client }); return { op, args }; },
  main: { getAccessLog: () => ({ items: [] }), takeScreenshot: async () => ({ png: Buffer.from('IMG'), width: 4, height: 3 }) },
});
test.before(() => api.configure({ enabled: true, port: 48400 + Math.floor(Math.random() * 400), permissions: { read: true, edit: true, ui: true } }));
test.after(() => api.stop());

const rpc = (server, method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, params });

test('it introduces itself and lists a tool per operation', async () => {
  const mcp = createServer({ dataDir: dir, version: '1.0.0' });
  const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  assert.strictEqual(init.result.serverInfo.name, 'httpdash');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /getStatus/);
  assert.strictEqual(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const { tools } = (await rpc(mcp, 'tools/list')).result;
  assert.strictEqual(tools.length, OPERATIONS.length);
  const update = tools.find((t) => t.name === 'updateRequest');
  assert.deepStrictEqual(update.inputSchema.required, ['requestId']);
  assert.ok(update.inputSchema.properties.request && update.inputSchema.properties.name);
  assert.strictEqual(tools.find((t) => t.name === 'deleteRequest').annotations.destructiveHint, true);
  assert.strictEqual(tools.find((t) => t.name === 'listCollections').annotations.readOnlyHint, true);
  assert.strictEqual((await rpc(mcp, 'nope/nothing')).error.code, -32601);
});

test('a tool call reaches the app with its path, query and body; screenshots are images', async () => {
  const mcp = createServer({ dataDir: dir, version: '1.0.0' });
  await rpc(mcp, 'initialize', { clientInfo: { name: 'claude-code' } });
  const r = await rpc(mcp, 'tools/call', { name: 'updateRequest', arguments: { requestId: 'r 1', name: 'Renamed', request: { tags: ['smoke'] } } });
  assert.strictEqual(r.result.isError, undefined);
  assert.deepStrictEqual(r.result.structuredContent, { op: 'updateRequest', args: { requestId: 'r 1', body: { name: 'Renamed', request: { tags: ['smoke'] } } } });
  assert.strictEqual(seen[seen.length - 1].client, 'MCP (claude-code)');
  const search = await rpc(mcp, 'tools/call', { name: 'searchRequests', arguments: { tag: 'smoke', limit: 3 } });
  assert.deepStrictEqual(search.result.structuredContent.args, { tag: 'smoke', limit: 3, body: {} });
  const shot = await rpc(mcp, 'tools/call', { name: 'takeScreenshot', arguments: { region: 'response' } });
  assert.deepStrictEqual(shot.result.content[0], { type: 'image', data: Buffer.from('IMG').toString('base64'), mimeType: 'image/png' });
});

test('errors say what to do', async () => {
  const off = createServer({ dataDir: path.join(dir, 'none') });
  const r = await rpc(off, 'tools/call', { name: 'getStatus', arguments: {} });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /Settings → AI access/);
  const mcp = createServer({ dataDir: dir });
  const denied = await rpc(mcp, 'tools/call', { name: 'sendRequest', arguments: { requestId: 'x' } });
  assert.strictEqual(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /"run" permission/);
});
