'use strict';

/**
 * Finds the instances behind a plain URL from DNS: when its host name resolves to several addresses
 * (round-robin DNS, a Kubernetes headless service, many internal load-balancing setups), each
 * address is an instance that Compare instances can send to directly.
 *
 * Only addresses of one family count (IPv4, else IPv6): a host with one IPv4 and one IPv6 address
 * is usually a single server reached two ways. Loopback addresses don't count, and neither does a
 * URL whose host is already an address. Answers are cached for a short while.
 */
const dns = require('dns');
const net = require('net');

const CACHE_MS = 30 * 1000;
const cache = new Map(); // host -> { at, addresses }

const isLoopback = (a) => a.family === 4 ? a.address.startsWith('127.') : a.address === '::1';

/**
 * Returns { host, protocol, port, family, addresses: [address] } when the URL's host has two or more
 * addresses of one family, otherwise null. opts: { fresh: skip the cache, lookup: for tests }.
 */
async function instancesFor(url, { fresh = false, lookup = dns.promises.lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || net.isIP(host)) return null;
  let entry = cache.get(host);
  if (fresh || !entry || Date.now() - entry.at > CACHE_MS) {
    let found;
    try { found = await lookup(host, { all: true }); } catch { found = []; }
    entry = { at: Date.now(), addresses: found };
    cache.set(host, entry);
  }
  const unique = (family) => [...new Set(entry.addresses.filter((a) => a.family === family && !isLoopback(a)).map((a) => a.address))];
  const v4 = unique(4);
  const v6 = unique(6);
  const [family, addresses] = v4.length >= 2 ? [4, v4] : v6.length >= 2 ? [6, v6] : [0, []];
  if (!family) return null;
  return { host, protocol: u.protocol, port: u.port || (u.protocol === 'https:' ? '443' : '80'), family, addresses };
}

module.exports = { instancesFor };
