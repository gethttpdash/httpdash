'use strict';

/**
 * Client certificates (mutual TLS) and extra CA certificates.
 *
 * settings.certificates: [{ host, port, crt, key, pfx, passphrase, enabled }]
 *   host may be a name ("api.example.com"), a wildcard ("*.example.com") or "*" for every host; port is optional
 *   and matches any port when empty. crt/key are PEM files, pfx a PKCS#12 file.
 * settings.caCertificate: { enabled, path } adds a PEM bundle to the trusted CAs.
 */
const fs = require('fs');
const path = require('path');
const tls = require('tls');

// Files are re-read only when they change, so the app picks up renewed certificates.
const fileCache = new Map();
function readFile(file, what) {
  let stat;
  try { stat = fs.statSync(file); } catch {
    throw Object.assign(new Error(`Could not read the ${what} at ${file}. Check the path in Settings → Certificates.`), { code: 'ECERTFILE' });
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  const data = fs.readFileSync(file);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

function hostMatches(pattern, hostname) {
  const p = String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const h = hostname.toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

// The first enabled certificate whose host (and port, if set) matches the URL.
function findCertificate(list, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return null;
  const port = String(u.port || 443);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  return (list || []).find((c) => c && c.enabled !== false && hostMatches(c.host, hostname) && (!c.port || String(c.port) === port)) || null;
}

/**
 * The TLS options for a URL: { cert, key, pfx, passphrase, ca, label } or null when nothing applies.
 * label describes the client certificate used, for the timeline.
 */
function tlsFor(url, settings = {}) {
  const out = {};
  const cert = findCertificate(settings.certificates, url);
  if (cert) {
    if (cert.pfx) out.pfx = readFile(cert.pfx, 'PFX file');
    if (cert.crt) out.cert = readFile(cert.crt, 'certificate file');
    if (cert.key) out.key = readFile(cert.key, 'key file');
    if (cert.passphrase) out.passphrase = cert.passphrase;
    if (!out.pfx && !(out.cert && out.key)) {
      throw Object.assign(new Error(`The client certificate for ${cert.host} needs a CRT and KEY file, or a PFX file.`), { code: 'ECERTFILE' });
    }
    out.label = cert.host + (cert.port ? `:${cert.port}` : '');
  }
  const ca = settings.caCertificate;
  if (ca && ca.enabled !== false && ca.path) {
    // Node's "ca" replaces the built-in roots, so keep them alongside the extra certificates.
    out.ca = [...tls.rootCertificates, readFile(ca.path, 'CA certificate file').toString('utf8')];
  }
  return Object.keys(out).length ? out : null;
}

// Reads Newman's --ssl-client-cert-list format: [{ matches: ["https://host:port/*"], cert: { src }, key: { src }, pfx: { src }, passphrase }].
// Relative paths are resolved against the list file's folder.
function fromNewmanList(list, baseDir) {
  const abs = (f) => (f && f.src ? path.resolve(baseDir, f.src) : '');
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    for (const pattern of [].concat(entry.matches || [])) {
      const m = /^(?:[a-z*]+:\/\/)?([^/:]+)(?::(\d+|\*))?/i.exec(String(pattern).trim());
      if (!m) continue;
      out.push({ host: m[1], port: m[2] && m[2] !== '*' ? m[2] : '', crt: abs(entry.cert), key: abs(entry.key), pfx: abs(entry.pfx), passphrase: entry.passphrase || '', enabled: true });
    }
  }
  return out;
}

module.exports = { tlsFor, findCertificate, hostMatches, fromNewmanList };
