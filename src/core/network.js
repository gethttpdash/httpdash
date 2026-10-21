'use strict';

/**
 * Where a request went on the network: the name's alias chain (CNAME) and every address it
 * resolves to, the address the connection was made to, each address split into its octets with its
 * segment (10.42.7.0/24) and kind (private, shared/VPN, loopback, link-local, public), whether it
 * sits on one of this machine's own segments, its reverse-DNS name, and the local address and
 * network adapter the request left from. Also a route trace with the system's traceroute.
 *
 * Name lookups go through the system resolver (the hosts file, VPN DNS, as every other app);
 * the TTLs come from asking DNS servers directly, which is also how a disagreement between the two
 * (split DNS) is noticed. Results are cached for a minute, so a run of many requests asks once.
 */
const dns = require('dns');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

const CACHE_MS = 60 * 1000;
const DNS_TIMEOUT = 1000;
const TRACE_BUDGET = 400; // how long a response waits for DNS details; they finish in the background
const MAX_CNAMES = 8;
const MAX_ADDRESSES = 32;

// ---- Addresses --------------------------------------------------------------------------------

/** { family: 4 | 6, bytes: [..] } for an IP address (IPv4-mapped IPv6 counts as IPv4), or null. */
function parse(ip) {
  let s = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) return { family: 4, bytes: s.split('.').map(Number) };
  if (!net.isIPv6(s)) return null;
  let [head, tail] = s.split('::');
  const groups = (part) => (part ? part.split(':') : []);
  let h = groups(head);
  let t = tail === undefined ? [] : groups(tail);
  // A trailing dotted IPv4 part is two groups.
  const v4 = (list) => {
    const last = list[list.length - 1];
    if (last && last.includes('.')) {
      const b = last.split('.').map(Number);
      list.splice(-1, 1, ((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
    }
    return list;
  };
  h = v4(h);
  t = v4(t);
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return { family: 6, bytes: all.flatMap((g) => [(g >> 8) & 255, g & 255]) };
}

const format = (p) => (p.family === 4
  ? p.bytes.join('.')
  : compress(Array.from({ length: 8 }, (_, i) => ((p.bytes[2 * i] << 8) | p.bytes[2 * i + 1]).toString(16))));

// The shortest IPv6 form: the longest run of zero groups becomes "::".
function compress(groups) {
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j;
  }
  if (best[0] < 0) return groups.join(':');
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
}

/** The address with everything past `bits` cleared. */
function mask(p, bits) {
  const bytes = p.bytes.map((b, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return b & ((0xff << (8 - keep)) & 0xff);
  });
  return { family: p.family, bytes };
}

const inRange = (p, base, bits) => p.family === base.family && mask(p, bits).bytes.every((b, i) => b === mask(base, bits).bytes[i]);

const RANGES = [
  ['127.0.0.0/8', 'loopback', 'Loopback: this machine'],
  ['10.0.0.0/8', 'private', 'Private network (10.0.0.0/8)'],
  ['172.16.0.0/12', 'private', 'Private network (172.16.0.0/12)'],
  ['192.168.0.0/16', 'private', 'Private network (192.168.0.0/16)'],
  ['100.64.0.0/10', 'shared', 'Shared address space (100.64.0.0/10): carrier-grade NAT, often a VPN'],
  ['169.254.0.0/16', 'link-local', 'Link-local (169.254.0.0/16): no address was assigned'],
  ['198.18.0.0/15', 'benchmark', 'Benchmarking network (198.18.0.0/15)'],
  ['224.0.0.0/4', 'multicast', 'Multicast'],
  ['0.0.0.0/8', 'unspecified', 'This network (0.0.0.0/8)'],
  ['::1/128', 'loopback', 'Loopback: this machine'],
  ['fc00::/7', 'private', 'Unique local address (fc00::/7): a private IPv6 network'],
  ['fe80::/10', 'link-local', 'Link-local (fe80::/10)'],
  ['ff00::/8', 'multicast', 'Multicast'],
  ['::/128', 'unspecified', 'Unspecified'],
].map(([cidr, kind, label]) => {
  const [ip, bits] = cidr.split('/');
  return { base: parse(ip), bits: Number(bits), kind, label, cidr };
});

function kindOf(p) {
  const r = RANGES.find((x) => inRange(p, x.base, x.bits));
  return r ? { kind: r.kind, label: r.label } : { kind: 'public', label: 'Public address' };
}

/** "10.42.7.0/24" for 10.42.7.31 and 24 bits. */
function segment(ip, bits) {
  const p = typeof ip === 'string' ? parse(ip) : ip;
  if (!p) return '';
  const b = bits == null ? (p.family === 4 ? 24 : 64) : Math.max(0, Math.min(p.family === 4 ? 32 : 128, Number(bits)));
  return `${format(mask(p, b))}/${b}`;
}

// This machine's own addresses and segments, read again at most every 30 seconds (a VPN comes and goes).
let ifaces = { at: 0, list: [] };
function interfaces(read = os.networkInterfaces) {
  if (Date.now() - ifaces.at < 30000 && read === os.networkInterfaces) return ifaces.list;
  const list = [];
  for (const [name, addrs] of Object.entries(read() || {})) {
    for (const a of addrs || []) {
      const p = parse(a.address);
      if (!p) continue;
      const bits = a.cidr ? Number(a.cidr.split('/')[1]) : (p.family === 4 ? 24 : 64);
      list.push({ name, address: format(p), bits, cidr: segment(p, bits), internal: !!a.internal, parsed: p });
    }
  }
  if (read === os.networkInterfaces) ifaces = { at: Date.now(), list };
  return list;
}

/**
 * Everything about one address: { address, family, octets (IPv4) or groups (IPv6), kind, label,
 * segment, ownSegment: the adapter of this machine on the same segment, or null }.
 */
function describe(ip, { bits4 = 24, bits6 = 64, own = interfaces() } = {}) {
  const p = parse(ip);
  if (!p) return null;
  const k = kindOf(p);
  const mine = own.find((i) => i.parsed.family === p.family && inRange(p, i.parsed, i.bits) && !(i.internal && k.kind !== 'loopback'));
  return {
    address: format(p),
    family: p.family,
    ...(p.family === 4 ? { octets: p.bytes } : { groups: Array.from({ length: 8 }, (_, i) => ((p.bytes[2 * i] << 8) | p.bytes[2 * i + 1]).toString(16)) }),
    kind: k.kind,
    label: k.label,
    segment: segment(p, p.family === 4 ? bits4 : bits6),
    ownSegment: mine ? { adapter: mine.name, cidr: mine.cidr } : null,
  };
}

/** The adapter a local address belongs to: { adapter, address, cidr }. */
function adapterOf(localAddress, own = interfaces()) {
  const p = parse(localAddress);
  if (!p) return null;
  const a = own.find((i) => i.parsed.family === p.family && i.parsed.bytes.every((b, n) => b === p.bytes[n]));
  return { address: format(p), adapter: a ? a.name : null, cidr: a ? a.cidr : null };
}

/** Whether an address is inside a range such as 10.42.0.0/16. */
function inCidr(ip, cidr) {
  const [base, bits] = String(cidr || '').split('/');
  const p = parse(ip);
  const b = parse(base);
  if (!p || !b || bits === undefined || !/^\d+$/.test(bits)) return false;
  return inRange(p, b, Number(bits));
}

// ---- DNS --------------------------------------------------------------------------------------

const within = (promise, ms, fallback) => Promise.race([promise.catch(() => fallback), new Promise((r) => { const t = setTimeout(() => r(fallback), ms); if (t.unref) t.unref(); })]);

const cache = new Map();
const cached = (key, make) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
};

/**
 * How a host name resolves: { host, cnames: [names it is an alias of, in order], addresses:
 * [{ address, family, ttl? }] in the order the system resolver gives them, direct: the addresses
 * DNS servers give when asked directly (null if they couldn't be asked), splitDns: whether the two
 * disagree, error }.
 */
function resolveHost(host, { resolver = dns.promises, timeout = DNS_TIMEOUT } = {}) {
  return cached(`host:${host}`, () => (async () => {
    const out = { host, cnames: [], addresses: [], direct: null, splitDns: false };
    const system = within(resolver.lookup(host, { all: true, verbatim: true }), timeout, null);
    // DNS servers don't know localhost or a single-label name (the hosts file or a search domain
    // does): only the system resolver is asked about those.
    const askServers = !/(^|\.)localhost$/i.test(host) && host.includes('.');
    // The alias chain, one name at a time; the addresses are asked for the name itself meanwhile
    // (for a name with no alias, that's the answer).
    const chain = (async () => {
      let name = host;
      for (let i = 0; askServers && i < MAX_CNAMES; i++) {
        const next = await within(resolver.resolveCname(name), timeout, null);
        if (!next || !next.length || next[0] === name) break;
        name = next[0];
        out.cnames.push(name);
      }
      return name;
    })();
    const ask = (name) => (askServers ? Promise.all([within(resolver.resolve4(name, { ttl: true }), timeout, null), within(resolver.resolve6(name, { ttl: true }), timeout, null)]) : Promise.resolve([null, null]));
    const [first, sys, name] = await Promise.all([ask(host), system, chain]);
    const [v4, v6] = name === host ? first : await ask(name);
    const ttl = new Map([...(v4 || []), ...(v6 || [])].map((r) => [r.address, r.ttl]));
    if (v4 || v6) out.direct = [...(v4 || []), ...(v6 || [])].map((r) => r.address);
    if (sys) out.addresses = sys.slice(0, MAX_ADDRESSES).map((a) => ({ address: a.address, family: a.family, ...(ttl.has(a.address) ? { ttl: ttl.get(a.address) } : {}) }));
    else out.error = 'The system resolver gave no address in time';
    if (out.direct && out.direct.length && out.addresses.length) {
      const a = new Set(out.addresses.map((x) => x.address));
      out.splitDns = out.direct.some((x) => !a.has(x)) || out.addresses.some((x) => !out.direct.includes(x.address));
    }
    return out;
  })());
}

/** The reverse-DNS (PTR) names of an address, or []. */
function reverse(ip, { resolver = dns.promises, timeout = DNS_TIMEOUT } = {}) {
  return cached(`ptr:${ip}`, () => within(resolver.reverse(ip), timeout, []));
}

/**
 * The network side of one request:
 * { host, viaProxy, tunnel, connected: describe() + ptr, local: adapterOf(), resolution: resolveHost() }
 * Addresses carry `used` when the request connected to them.
 */
async function trace({ url, remoteAddress, localAddress, viaProxy = false, tunnel = null }, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { /* not a URL */ }
  // Through a tunnel the name is resolved, and the connection made, on the far side: nothing here
  // would describe it.
  if (tunnel) return { host, viaProxy: false, tunnel, connected: null, local: null, resolution: null };
  const own = opts.interfaces || interfaces();
  const out = { host, viaProxy: !!viaProxy, connected: null, local: localAddress ? adapterOf(localAddress, own) : null, resolution: null };
  const literal = !!parse(host);
  // DNS details are waited for only briefly: they carry on in the background and are cached, so
  // a slow or blocked DNS server never holds up a response.
  const budget = opts.budget == null ? TRACE_BUDGET : opts.budget;
  const [resolution, ptr] = await Promise.all([
    host && !literal ? within(resolveHost(host, opts), budget, null) : Promise.resolve(null),
    remoteAddress && !viaProxy ? within(reverse(remoteAddress, opts), budget, []) : Promise.resolve([]),
  ]);
  if (host && !literal && !resolution) out.pending = true;
  if (remoteAddress) out.connected = { ...describe(remoteAddress, { ...opts, own }), ptr };
  if (resolution) {
    const used = out.connected && !viaProxy ? out.connected.address : null;
    out.resolution = {
      ...resolution,
      addresses: resolution.addresses.map((a) => ({ ...a, ...describe(a.address, { ...opts, own }), used: !!used && describe(a.address).address === used })),
    };
  }
  return out;
}

/** Starts the lookups for a URL's host ahead of time, so trace() finds them done. */
function prefetch(url, opts) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (host && !parse(host)) resolveHost(host, opts).catch(() => {});
  } catch { /* not a URL */ }
}

// ---- Route ------------------------------------------------------------------------------------

/**
 * The route to a host with the system's traceroute (tracert on Windows): [{ hop, address, ms }]
 * (address null for a hop that didn't answer). Each hop is described like any other address.
 */
function traceRoute(host, { maxHops = 20, platform = process.platform, run = execFile, timeoutMs = 60000 } = {}) {
  const target = String(host || '').replace(/^\[|\]$/g, '');
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(target)) return Promise.reject(new Error('Not a host name or address'));
  const hops = Math.max(1, Math.min(64, Number(maxHops) || 20));
  const win = platform === 'win32';
  const cmd = win ? 'tracert' : 'traceroute';
  const args = win ? ['-d', '-h', String(hops), '-w', '1000', target] : ['-n', '-q', '1', '-w', '1', '-m', String(hops), target];
  return new Promise((resolve, reject) => {
    run(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const list = parseRoute(String(stdout || ''));
      if (err && !list.length) {
        reject(new Error(err.code === 'ENOENT' ? `${cmd} is not installed on this computer` : String(stderr || err.message).trim().split('\n')[0]));
        return;
      }
      resolve(list.map((x) => ({ ...x, ...(x.address ? describe(x.address) : {}) })));
    });
  });
}

function parseRoute(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const times = [...rest.matchAll(/<?\s*([\d.]+)\s*ms/g)].map((x) => Number(x[1]));
    const addr = (rest.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)/i) || [])[1] || null;
    const silent = !addr && /\*/.test(rest);
    if (!addr && !silent) continue;
    out.push({ hop: Number(m[1]), address: addr && parse(addr) ? addr : null, ms: times.length ? Math.min(...times) : null });
  }
  return out;
}

module.exports = { parse, inCidr, segment, describe, adapterOf, interfaces, resolveHost, reverse, trace, prefetch, traceRoute, parseRoute, kindOf };
