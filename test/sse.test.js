'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createParser, parseEventStream, isEventStream } = require('../src/core/sse');
const { execute } = require('../src/core/executor');
const { newRequestDef } = require('../src/core/model');

test('the parser follows the event-stream format', () => {
  const events = parseEventStream([
    ': a comment',
    'data: first',
    '',
    'event: update',
    'id: 7',
    'data: line one',
    'data:line two',
    '',
    'retry: 3000',
    'data',
    '',
    'data: no blank line at the end',
  ].join('\n'));
  assert.deepStrictEqual(events, [
    { event: 'message', data: 'first', id: '' },
    { event: 'update', data: 'line one\nline two', id: '7' },
    { event: 'message', data: '', id: '7' }, // the id carries over
  ]);
  const p = createParser();
  p.push('retry: 3000\n: hi\n\n');
  assert.strictEqual(p.retry, 3000);
  assert.strictEqual(p.comments, 1);
  assert.ok(isEventStream('text/event-stream; charset=utf-8'));
  assert.ok(!isEventStream('application/json'));
});

test('lines split across chunks and every line ending style parse the same', () => {
  const text = 'event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\rdata: 3\n\n';
  const whole = parseEventStream(text);
  assert.deepStrictEqual(whole.map((e) => `${e.event}:${e.data}`), ['a:1', 'b:2', 'message:3']);
  for (const size of [1, 2, 3, 5]) {
    const p = createParser();
    const got = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
    assert.deepStrictEqual(got, whole, `chunks of ${size}`);
  }
});

// A server that streams events slowly, like an AI completion endpoint.
function startServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const words = req.method === 'POST' ? JSON.parse(body).prompt.split(' ') : ['a', 'b', 'c'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) res.write(`event: token\ndata: ${JSON.stringify({ text: words[i++] })}\n\n`);
        else { res.write('event: done\ndata: [DONE]\n\n'); res.end(); clearInterval(timer); }
      }, 30);
      res.on('close', () => clearInterval(timer)); // the client went away (req 'close' fires once the body is read)
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('events stream in as they arrive, with timings', async () => {
  const server = await startServer();
  try {
    const live = [];
    const res = await execute({
      request: newRequestDef({ method: 'POST', url: `http://127.0.0.1:${server.address().port}/v1/stream`, body: { mode: 'raw', raw: '{"prompt":"one two three"}' } }),
      scopes: { globals: {}, collection: {}, environment: {}, data: {} },
      onStream: (ev) => live.push(ev),
    });
    assert.strictEqual(res.error, undefined);
    assert.deepStrictEqual(live.map((e) => e.event === 'token' ? JSON.parse(e.data).text : e.data), ['one', 'two', 'three', '[DONE]']);
    assert.ok(live[3].t > live[0].t, 'later events have later times');
    assert.strictEqual(res.response.events.length, 4);
    assert.match(res.response.bodyText, /event: done/);
  } finally { server.close(); }
});

test('stopping a stream keeps what arrived', async () => {
  const server = await startServer();
  try {
    const controller = new AbortController();
    const live = [];
    const res = await execute({
      request: newRequestDef({ method: 'POST', url: `http://127.0.0.1:${server.address().port}/`, body: { mode: 'raw', raw: JSON.stringify({ prompt: 'w '.repeat(50).trim() }) } }),
      scopes: { globals: {}, collection: {}, environment: {}, data: {} },
      signal: controller.signal,
      onStream: (ev) => { live.push(ev); if (live.length === 3) controller.abort(); },
    });
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response.cancelled, true);
    assert.strictEqual(res.response.status, 200);
    assert.ok(res.response.events.length >= 3 && res.response.events.length < 50);
  } finally { server.close(); }
});
