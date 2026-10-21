'use strict';

/**
 * Tunnels into internal networks: requests to some hosts, or every request of an environment, go
 * through an SSH jump host or a SOCKS5 proxy, so services on a private network (a plant, a data
 * center, a cluster) can be called without a VPN. Host names are resolved on the far side.
 *
 * Tunnel: {
 *   id, name, type: 'ssh' | 'socks5', enabled,
 *   ssh: { host, port, user, identityFile, jump, acceptNewHostKey },
 *   socks: { host, port, username, password },
 *   hosts: ['*.mes.corp', '10.42.0.0/16', 'orders.internal'],   // which request hosts use it
 * }
 *
 * An SSH tunnel runs the system's ssh with dynamic port forwarding (-D) on a free local port, so the
 * user's keys, agent, ~/.ssh/config and known_hosts apply exactly as in a terminal. It starts on
 * first use and stays up; if ssh exits, the next request starts it again. ssh runs without a
 * shell, in batch mode (it never waits for a password), and every value it is given is checked
 * so that none can be read as an option.
 */
const net = require('net');
const { spawn } = require('child_process');
const network = require('./network');

const START_TIMEOUT = 20000;

class TunnelError extends Error {
  constructor(message) { super(message); this.code = 'ETUNNEL'; }
}

// ---- Which requests go through which tunnel ---------------------------------------------------

/** Whether a host matches a pattern: a name with * wildcards (*.mes.corp, 10.42.*) or a CIDR range. */
function hostMatches(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const p = String(pattern || '').trim().toLowerCase();
  if (!h || !p) return false;
  if (p.includes('/')) return network.inCidr(h, p);
  const re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(h);
}

/**
 * The tunnel a URL goes through, or null.
 * tunnelId: undefined (the active environment's choice applies), 'auto' (by host only), 'none', or
 * a tunnel's id. envTunnelId: the active environment's choice, used when tunnelId is undefined.
 */
function routeFor(url, tunnels, { tunnelId, envTunnelId } = {}) {
  const list = (tunnels || []).filter((t) => t && t.enabled !== false);
  const choice = tunnelId === undefined ? envTunnelId : tunnelId;
  if (choice === 'none') return null;
  if (choice && choice !== 'auto') return list.find((t) => t.id === choice) || null;
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  return list.find((t) => (t.hosts || []).some((p) => hostMatches(host, p))) || null;
}

// ---- SSH --------------------------------------------------------------------------------------

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9._:-]*)$/;

/** The ssh arguments for a tunnel listening on localPort. Throws on a value that isn't safe to pass. */
function sshArgs(cfg, localPort) {
  const c = cfg || {};
  const host = String(c.host || '').trim();
  const user = String(c.user || '').trim();
  const jump = String(c.jump || '').trim();
  if (!HOST.test(host)) throw new TunnelError('The SSH host must be a host name or an address');
  if (user && !NAME.test(user)) throw new TunnelError('The SSH user name has characters ssh would not accept');
  const port = c.port === undefined || c.port === null || c.port === '' ? null : Number(c.port);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new TunnelError('The SSH port must be between 1 and 65535');
  if (jump && !jump.split(',').every((j) => /^([A-Za-z0-9_][A-Za-z0-9._-]*@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*)(:\d{1,5})?$/.test(j.trim()))) {
    throw new TunnelError('Jump hosts are written user@host:port, separated by commas');
  }
  const args = ['-N', '-D', `127.0.0.1:${localPort}`,
    '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15'];
  if (c.acceptNewHostKey) args.push('-o', 'StrictHostKeyChecking=accept-new');
  if (port !== null) args.push('-p', String(port));
  if (c.identityFile) args.push('-i', String(c.identityFile));
  if (jump) args.push('-J', jump);
  args.push(user ? `${user}@${host}` : host);
  return args;
}

// What ssh's last words mean, in plain language.
function explainSsh(stderr, code) {
  const s = String(stderr || '').trim();
  if (/Permission denied/i.test(s)) return 'The SSH server refused the key. Check the user name and that your key is loaded (ssh-add) or set as the identity file. Passwords are not asked for.';
  if (/Host key verification failed/i.test(s)) return 'The SSH host key is not known yet. Connect once with ssh in a terminal to accept it, or tick "Accept a new host key the first time".';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return 'The SSH host key has changed since you last connected. Check with whoever runs the jump host before trusting it.';
  if (/Could not resolve hostname/i.test(s)) return `ssh could not find the host: ${s.split('\n').pop()}`;
  if (/Connection (timed out|refused)|Operation timed out/i.test(s)) return `ssh could not reach the host: ${s.split('\n').pop()}`;
  const last = s.split('\n').filter(Boolean).pop();
  return last ? `ssh stopped: ${last}` : `ssh stopped (exit code ${code})`;
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// ---- The tunnels of a workspace ---------------------------------------------------------------

class TunnelManager {
  /** opts: { spawn (for tests), onStatus(list), command: 'ssh' } */
  constructor(opts = {}) {
    this.spawn = opts.spawn || spawn;
    this.command = opts.command || 'ssh';
    this.onStatus = opts.onStatus || (() => {});
    this.tunnels = [];
    this.envTunnelId = undefined;
    this.running = new Map(); // id -> { proc, port, sig, starting, state, error, since, stderr }
  }

  /** The workspace's tunnels and the active environment's choice. Changed or removed SSH tunnels stop. */
  configure({ tunnels = [], envTunnelId } = {}) {
    this.tunnels = tunnels;
    this.envTunnelId = envTunnelId;
    for (const [id, r] of this.running) {
      const t = tunnels.find((x) => x.id === id);
      if (!t || t.enabled === false || signature(t) !== r.sig) this.stop(id);
    }
  }

  route(url, opts = {}) { return routeFor(url, this.tunnels, { ...opts, envTunnelId: this.envTunnelId }); }

  /** The SOCKS5 endpoint for a URL: { host, port, username, password, label } or null. */
  async socksFor(url, opts) {
    const t = this.route(url, opts);
    if (!t) return null;
    if (t.type === 'socks5') {
      const s = t.socks || {};
      if (!s.host) throw new TunnelError(`Tunnel "${t.name}" has no SOCKS host`);
      return { host: s.host, port: Number(s.port) || 1080, username: s.username || '', password: s.password || '', label: t.name };
    }
    const port = await this.start(t);
    return { host: '127.0.0.1', port, label: t.name };
  }

  /** Starts an SSH tunnel (or waits for the one starting) and returns its local port. */
  start(t) {
    const cur = this.running.get(t.id);
    if (cur && cur.state === 'up' && cur.sig === signature(t)) return Promise.resolve(cur.port);
    if (cur && cur.starting) return cur.starting;
    const entry = { sig: signature(t), state: 'starting', error: null, since: Date.now(), stderr: '', name: t.name };
    this.running.set(t.id, entry);
    entry.starting = (async () => {
      const port = await freePort();
      const args = sshArgs(t.ssh, port);
      entry.port = port;
      const proc = this.spawn(this.command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      entry.proc = proc;
      let exited = null;
      proc.stderr && proc.stderr.on('data', (d) => { entry.stderr = (entry.stderr + d).slice(-4000); });
      proc.on('error', (e) => { exited = { error: e.code === 'ENOENT' ? 'ssh is not installed on this computer (on Windows: Settings → Optional features → OpenSSH Client)' : e.message }; });
      proc.on('exit', (code) => {
        if (!exited) exited = { code };
        if (entry.state === 'up') { entry.state = 'stopped'; entry.error = explainSsh(entry.stderr, code); this.report(); }
      });
      const deadline = Date.now() + START_TIMEOUT;
      while (Date.now() < deadline) {
        if (exited) throw new TunnelError(exited.error || explainSsh(entry.stderr, exited.code));
        if (await canConnect(port)) {
          entry.state = 'up';
          entry.since = Date.now();
          this.report();
          return port;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      try { proc.kill(); } catch { /* gone */ }
      throw new TunnelError(`ssh did not open the tunnel within ${START_TIMEOUT / 1000} seconds${entry.stderr ? `: ${entry.stderr.trim().split('\n').pop()}` : ''}`);
    })().then((port) => { entry.starting = null; return port; }, (e) => {
      entry.starting = null;
      entry.state = 'error';
      entry.error = e.message;
      this.report();
      throw e instanceof TunnelError ? e : new TunnelError(e.message);
    });
    this.report();
    return entry.starting;
  }

  stop(id) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    try { if (r.proc && r.proc.exitCode === null) r.proc.kill(); } catch { /* gone */ }
    this.report();
  }

  stopAll() { for (const id of [...this.running.keys()]) this.stop(id); }

  status() {
    return this.tunnels.map((t) => {
      const r = this.running.get(t.id);
      return { id: t.id, name: t.name, type: t.type, state: t.type === 'socks5' ? 'ready' : r ? r.state : 'stopped', error: r ? r.error : null, port: r ? r.port : null, since: r ? r.since : null };
    });
  }

  report() { try { this.onStatus(this.status()); } catch { /* the window is gone */ } }
}

const signature = (t) => JSON.stringify([t.type, t.ssh || {}, t.socks || {}]);

module.exports = { TunnelManager, TunnelError, hostMatches, routeFor, sshArgs, explainSsh };
