'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocketServer } = require('ws');
const { operations, selectedOperation, isSubscription, subscribe } = require('../src/core/graphql');
const { execute } = require('../src/core/executor');
const { newRequestDef } = require('../src/core/model');

test('operations are found by type and name, past strings, comments and fragments', () => {
  const doc = `
    # query Commented { x }
    query Orders($first: Int = 10, $q: String = "a { b") @live { orders(first: $first) { id note(where: "}") } }
    mutation Cancel { cancel(id: 1) { ok } }
    fragment F on Order { id }
    """ A described subscription { not a query } """
    subscription OnOrder { orderChanged { ...F } }
    { anonymous }
  `;
  assert.deepStrictEqual(operations(doc), [
    { type: 'query', name: 'Orders' },
    { type: 'mutation', name: 'Cancel' },
    { type: 'subscription', name: 'OnOrder' },
    { type: 'query', name: null },
  ]);
  assert.deepStrictEqual(operations('{ me { id } }'), [{ type: 'query', name: null }]);
  assert.deepStrictEqual(operations('query { a }'), [{ type: 'query', name: null }]);
  assert.deepStrictEqual(operations(''), []);
  assert.strictEqual(selectedOperation(doc, 'Cancel').type, 'mutation');
  assert.strictEqual(selectedOperation(doc, 'Missing'), null);
  assert.strictEqual(selectedOperation(doc), null, 'several operations and no name: none is selected');
  assert.ok(isSubscription('subscription { tick }'));
  assert.ok(isSubscription(doc, 'OnOrder'));
  assert.ok(!isSubscription(doc, 'Orders'));
});

// A GraphQL-over-WebSocket server speaking either protocol: three results for "count", an error for "fail".
function startServer() {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (server.protocol && protocols.has(server.protocol) ? server.protocol : [...protocols][0]),
  });
  wss.on('connection', (socket, req) => {
    const legacy = socket.protocol === 'graphql-ws';
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_init') {
        if (server.requireAuth && req.headers.authorization !== 'Bearer t0k') return socket.close(4403, 'Forbidden');
        socket.send(JSON.stringify({ type: 'connection_ack' }));
        if (!legacy) socket.send(JSON.stringify({ type: 'ping' }));
        return;
      }
      if (msg.type === 'pong') { server.pongs = (server.pongs || 0) + 1; return; }
      if (msg.type === (legacy ? 'start' : 'subscribe')) {
        server.lastPayload = msg.payload;
        if (/fail/.test(msg.payload.query)) return socket.send(JSON.stringify({ id: msg.id, type: 'error', payload: [{ message: 'No such field: fail' }] }));
        const n = /forever/.test(msg.payload.query) ? Infinity : 3;
        let i = 0;
        const timer = setInterval(() => {
          if (socket.readyState !== 1) return clearInterval(timer);
          if (i >= n) { clearInterval(timer); socket.send(JSON.stringify({ id: msg.id, type: 'complete' })); return; }
          i++;
          socket.send(JSON.stringify({ id: msg.id, type: legacy ? 'data' : 'next', payload: { data: { count: i } } }));
        }, 10);
        socket.on('close', () => clearInterval(timer));
      }
      if (msg.type === 'complete' || msg.type === 'stop') server.stopped = true;
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('a subscription streams every result until the server completes it (graphql-transport-ws)', async () => {
  const s = await startServer();
  try {
    const events = [];
    const raw = await subscribe({ url: `http://127.0.0.1:${s.port}/graphql`, headers: [['Content-Type', 'application/json']], payload: { query: 'subscription { count }', variables: { a: 1 } }, onEvent: (e) => events.push(e) });
    assert.strictEqual(raw.status, 101);
    assert.strictEqual(raw.subscription.protocol, 'graphql-transport-ws');
    assert.deepStrictEqual(events.map((e) => e.event), ['next', 'next', 'next', 'complete']);
    assert.deepStrictEqual(JSON.parse(events[2].data), { data: { count: 3 } });
    assert.deepStrictEqual(JSON.parse(raw.body.toString()), [{ data: { count: 1 } }, { data: { count: 2 } }, { data: { count: 3 } }]);
    assert.deepStrictEqual(s.server.lastPayload, { query: 'subscription { count }', variables: { a: 1 } });
    assert.strictEqual(s.server.pongs, 1, "the server's ping is answered");
  } finally { s.server.close(); }
});

test('the legacy subscriptions-transport-ws protocol works too, and errors end the subscription', async () => {
  const s = await startServer();
  s.server.protocol = 'graphql-ws';
  try {
    const raw = await subscribe({ url: `ws://127.0.0.1:${s.port}/graphql`, payload: { query: 'subscription { count }' } });
    assert.strictEqual(raw.subscription.protocol, 'graphql-ws');
    assert.strictEqual(JSON.parse(raw.body.toString()).length, 3);
    const failed = await subscribe({ url: `ws://127.0.0.1:${s.port}/graphql`, payload: { query: 'subscription { fail }' } });
    assert.strictEqual(failed.subscription.error, 'No such field: fail');
    assert.deepStrictEqual(JSON.parse(failed.body.toString()), [{ errors: [{ message: 'No such field: fail' }] }]);
  } finally { s.server.close(); }
});

test('stopping a subscription tells the server, and a refusal says why', async () => {
  const s = await startServer();
  try {
    const controller = new AbortController();
    const events = [];
    const pending = subscribe({ url: `http://127.0.0.1:${s.port}/`, payload: { query: 'subscription { forever }' }, signal: controller.signal, onEvent: (e) => { events.push(e); if (events.length === 2) controller.abort(); } });
    const raw = await pending;
    assert.ok(raw.cancelled);
    assert.strictEqual(events.length, 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.server.stopped, 'the server was told to stop');

    s.server.requireAuth = true;
    const refused = await subscribe({ url: `http://127.0.0.1:${s.port}/`, payload: { query: 'subscription { count }' } });
    assert.match(refused.subscription.error, /4403 Forbidden/);
    const allowed = await subscribe({ url: `http://127.0.0.1:${s.port}/`, headers: [['Authorization', 'Bearer t0k']], payload: { query: 'subscription { count }' } });
    assert.strictEqual(JSON.parse(allowed.body.toString()).length, 3, 'headers go with the handshake');
  } finally { s.server.close(); }
});

test('a GraphQL request whose operation is a subscription runs over a WebSocket, with variables and auth', async () => {
  const s = await startServer();
  try {
    const request = newRequestDef({
      method: 'POST', url: `http://127.0.0.1:${s.port}/graphql`,
      auth: { type: 'bearer', bearer: { token: '{{token}}' } },
      body: { mode: 'graphql', graphql: { query: 'query Q { a }\nsubscription Counter { count }', variables: '{"n": {{n}}}', operationName: 'Counter' } },
      testScript: "pm.test('three results', () => pm.expect(pm.response.json()).to.have.length(3));",
    });
    s.server.requireAuth = true;
    const streamed = [];
    const res = await execute({ request, scopes: { environment: { token: 't0k', n: '5' } }, onStream: (e) => streamed.push(e) });
    assert.ifError(res.error);
    assert.strictEqual(res.response.status, 101);
    assert.strictEqual(res.response.events.length, 4);
    assert.strictEqual(streamed.length, 4, 'results stream to the window as they arrive');
    assert.deepStrictEqual(s.server.lastPayload, { query: 'query Q { a }\nsubscription Counter { count }', variables: { n: 5 }, operationName: 'Counter' });
    assert.deepStrictEqual(res.tests.map((t) => t.passed), [true]);

    // In a run (no one watching), it ends after the first result.
    const run = await execute({ request, scopes: { environment: { token: 't0k', n: '1' } } });
    assert.strictEqual(JSON.parse(run.response.bodyText).length, 1);
  } finally { s.server.close(); }
});
