'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { EventEmitter } = require('events');
const { TunnelManager, hostMatches, routeFor, sshArgs, explainSsh } = require('../src/core/tunnels');
const httpClient = require('../src/core/http-client');
const { execute } = require('../src/core/executor');
const { startServer } = require('./helpers');

/**
 * A SOCKS5 server for the tests. Names are resolved on its side through `names` (so a name this
 * computer can't resolve still works), and `auth` asks for a user name and password.
 */
function socksServer({ names = {}, auth = null } = {}) {
  const seen = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let step = 'hello';
    client.on('error', () => {});
    client.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (step === 'hello' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (auth) { client.write(Buffer.from([5, methods.includes(2) ? 2 : 0xff])); step = 'auth'; } else { client.write(Buffer.from([5, 0])); step = 'request'; }
      }
      if (step === 'auth' && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        const user = buf.subarray(2, 2 + ul).toString();
        const pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        const ok = user === auth.user && pass === auth.pass;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) { client.end(); return; }
        step = 'request';
      }
      if (step === 'request' && buf.length >= 5) {
        const atyp = buf[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + len + 2) return;
        const host = atyp === 1 ? [...buf.subarray(4, 8)].join('.') : atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : '::1';
        const port = buf.readUInt16BE(4 + len);
        seen.push(`${host}:${port}`);
        step = 'piping';
        client.removeListener('data', onData);
        const address = names[host] || host;
        const upstream = net.connect(port, address);
        upstream.on('connect', () => { client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); client.pipe(upstream); upstream.pipe(client); });
        upstream.on('error', () => { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

const req = (url) => ({ method: 'GET', url, params: [], headers: [], body: { mode: 'none' } });
const scopes = () => ({ globals: {}, collection: {}, environment: {}, data: {} });

test('hosts match by name with wildcards, or by address range', () => {
  assert.ok(hostMatches('orders.mes.corp', '*.mes.corp'));
  assert.ok(!hostMatches('mes.corp.evil.com', '*.mes.corp'));
  assert.ok(hostMatches('10.42.7.31', '10.42.0.0/16'));
  assert.ok(!hostMatches('10.43.7.31', '10.42.0.0/16'));
  assert.ok(hostMatches('10.42.7.31', '10.42.*'));
  assert.ok(hostMatches('[fd00::5]', 'fd00::/8'));
  assert.ok(hostMatches('Consul.Plant.Local', 'consul.plant.local'));
});

test('a request goes through the environment\'s tunnel, the host\'s tunnel, or none', () => {
  const tunnels = [{ id: 'a', name: 'Plant', hosts: ['*.mes.corp'] }, { id: 'b', name: 'DC', hosts: ['10.0.0.0/8'] }, { id: 'c', name: 'Off', enabled: false, hosts: ['*'] }];
  assert.strictEqual(routeFor('http://orders.mes.corp/x', tunnels).id, 'a');
  assert.strictEqual(routeFor('http://10.1.2.3:8080/x', tunnels).id, 'b');
  assert.strictEqual(routeFor('https://example.com/', tunnels), null, 'a switched-off tunnel is never used');
  assert.strictEqual(routeFor('https://example.com/', tunnels, { envTunnelId: 'b' }).id, 'b', 'the environment sends everything through its tunnel');
  assert.strictEqual(routeFor('http://orders.mes.corp/', tunnels, { tunnelId: 'none', envTunnelId: 'b' }), null);
  assert.strictEqual(routeFor('http://orders.mes.corp/', tunnels, { tunnelId: 'auto', envTunnelId: 'b' }).id, 'a', 'auto: by host, whatever the active environment');
});

test('ssh is given only values it cannot read as options', () => {
  const args = sshArgs({ host: 'jump.mes.corp', user: 'dana', port: 2222, identityFile: '~/.ssh/id_ed25519', jump: 'ops@bastion.corp:22', acceptNewHostKey: true }, 41000);
  assert.deepStrictEqual(args.slice(0, 3), ['-N', '-D', '127.0.0.1:41000']);
  assert.ok(args.includes('BatchMode=yes'), 'never waits for a password');
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.deepStrictEqual(args.slice(-1), ['dana@jump.mes.corp']);
  assert.deepStrictEqual(args.slice(args.indexOf('-J'), args.indexOf('-J') + 2), ['-J', 'ops@bastion.corp:22']);
  assert.throws(() => sshArgs({ host: '-oProxyCommand=touch /tmp/x' }, 1), /host name/);
  assert.throws(() => sshArgs({ host: 'ok', user: '-oProxyCommand=x' }, 1), /user name/);
  assert.throws(() => sshArgs({ host: 'ok', jump: '-oProxyCommand=x' }, 1), /Jump hosts/);
  assert.throws(() => sshArgs({ host: 'ok', port: 70000 }, 1), /port/);
});

test('ssh failures are explained in plain words', () => {
  assert.match(explainSsh('dana@jump: Permission denied (publickey).', 255), /refused the key/);
  assert.match(explainSsh('Host key verification failed.', 255), /host key is not known/);
  assert.match(explainSsh('ssh: Could not resolve hostname jump.corp: nodename nor servname provided', 255), /could not find the host/);
});

test('a request through a SOCKS5 tunnel reaches a name only the far side knows', async () => {
  const srv = await startServer();
  const socks = await socksServer({ names: { 'orders.plant.internal': '127.0.0.1' } });
  const port = new URL(srv.base).port;
  httpClient.setRouter(async (url) => (new URL(url).hostname.endsWith('.plant.internal') ? { host: '127.0.0.1', port: socks.port, label: 'Plant' } : null));
  try {
    const res = await execute({ request: req(`http://orders.plant.internal:${port}/echo`), chain: [], scopes: scopes(), settings: {} });
    assert.strictEqual(res.error, undefined);
    assert.ok(res.response.status < 500);
    assert.strictEqual(res.response.tunnel, 'Plant');
    assert.ok(res.response.timings.tunnel != null);
    assert.deepStrictEqual(socks.seen, [`orders.plant.internal:${port}`], 'the name is sent to the far side, not resolved here');
    assert.strictEqual(res.network.tunnel, 'Plant');
    assert.strictEqual(res.network.connected, null);
    // Other hosts connect directly.
    const direct = await execute({ request: req(`${srv.base}/echo`), chain: [], scopes: scopes(), settings: {} });
    assert.strictEqual(direct.response.tunnel, undefined);
    // A host the far side can't reach is an error that names the tunnel.
    const down = await execute({ request: req('http://orders.plant.internal:1/x'), chain: [], scopes: scopes(), settings: {} });
    assert.match(down.error, /Plant|refused/);
  } finally {
    httpClient.setRouter(null);
    socks.server.close();
    srv.server.close();
  }
});

test('a SOCKS5 proxy with a user name and password', async () => {
  const srv = await startServer();
  const socks = await socksServer({ auth: { user: 'dana', pass: 's3cret' } });
  const port = new URL(srv.base).port;
  try {
    httpClient.setRouter(async () => ({ host: '127.0.0.1', port: socks.port, username: 'dana', password: 's3cret', label: 'Proxy' }));
    let res = await execute({ request: req(`http://127.0.0.1:${port}/echo`), chain: [], scopes: scopes(), settings: {} });
    assert.ok(res.response && res.response.status < 500, res.error);
    httpClient.setRouter(async () => ({ host: '127.0.0.1', port: socks.port, username: 'dana', password: 'wrong', label: 'Proxy' }));
    res = await execute({ request: req(`http://127.0.0.1:${port}/echo`), chain: [], scopes: scopes(), settings: {} });
    assert.match(res.error, /refused the user name or password/);
  } finally {
    httpClient.setRouter(null);
    socks.server.close();
    srv.server.close();
  }
});

// Stands in for ssh: listens on the -D port as a SOCKS server, or fails like ssh does.
function fakeSpawn({ fail } = {}) {
  const calls = [];
  const servers = [];
  const spawnFn = (cmd, args) => {
    calls.push([cmd, args]);
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.kill = () => { proc.exitCode = 0; for (const s of servers) s.close(); proc.emit('exit', 0); };
    const port = Number(args[args.indexOf('-D') + 1].split(':')[1]);
    setTimeout(async () => {
      if (fail) { proc.stderr.emit('data', fail); proc.exitCode = 255; proc.emit('exit', 255); return; }
      const s = await socksServer({ names: { 'lots.plant.internal': '127.0.0.1' } });
      s.server.close();
      const server = net.createServer((c) => { const u = net.connect(s.port); c.pipe(u); u.pipe(c); });
      // The real SOCKS logic, on the port ssh would listen on.
      const real = await socksServer({ names: { 'lots.plant.internal': '127.0.0.1' } });
      server.close();
      const fwd = net.createServer((c) => { const u = net.connect(real.port, '127.0.0.1'); c.on('error', () => {}); u.on('error', () => {}); c.pipe(u); u.pipe(c); });
      fwd.listen(port, '127.0.0.1');
      servers.push(fwd, real.server);
    }, 50);
    return proc;
  };
  return { spawnFn, calls, servers };
}

test('an SSH tunnel starts on first use, is reused, and stops when its settings change', async () => {
  const srv = await startServer();
  const fake = fakeSpawn();
  const mgr = new TunnelManager({ spawn: fake.spawnFn });
  const t = { id: 'plant', name: 'Plant', type: 'ssh', ssh: { host: 'jump.mes.corp', user: 'dana' }, hosts: ['*.plant.internal'] };
  mgr.configure({ tunnels: [t] });
  httpClient.setRouter((url, o) => mgr.socksFor(url, o));
  try {
    const port = new URL(srv.base).port;
    const [a, b] = await Promise.all([
      execute({ request: req(`http://lots.plant.internal:${port}/echo`), chain: [], scopes: scopes(), settings: {} }),
      execute({ request: req(`http://lots.plant.internal:${port}/echo`), chain: [], scopes: scopes(), settings: {} }),
    ]);
    assert.ok(a.response && b.response, a.error || b.error);
    assert.strictEqual(fake.calls.length, 1, 'one ssh for both requests');
    assert.strictEqual(fake.calls[0][0], 'ssh');
    assert.strictEqual(mgr.status()[0].state, 'up');
    mgr.configure({ tunnels: [{ ...t, ssh: { host: 'jump2.mes.corp', user: 'dana' } }] });
    assert.strictEqual(mgr.status()[0].state, 'stopped', 'a changed tunnel is closed, and opens again on next use');
  } finally {
    httpClient.setRouter(null);
    mgr.stopAll();
    srv.server.close();
  }
});

test('an SSH tunnel that cannot open says why', async () => {
  const mgr = new TunnelManager({ spawn: fakeSpawn({ fail: 'dana@jump.mes.corp: Permission denied (publickey).\n' }).spawnFn });
  mgr.configure({ tunnels: [{ id: 'p', name: 'Plant', type: 'ssh', ssh: { host: 'jump.mes.corp' }, hosts: ['*'] }] });
  await assert.rejects(mgr.socksFor('http://anything/'), /refused the key/);
  assert.strictEqual(mgr.status()[0].state, 'error');
});
