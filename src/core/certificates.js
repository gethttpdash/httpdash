'use strict';

/**
 * Client certificates (mutual TLS) and trusted CA certificates.
 *
 * settings.certificates: [{ host, port, crt, key, pfx, passphrase, enabled }]
 *   host may be a name ("api.example.com"), a wildcard ("*.example.com") or "*" for every host; port is optional
 *   and matches any port when empty. crt/key are PEM files, pfx a PKCS#12 file.
 * settings.caCertificate: { enabled, path } adds a PEM bundle to the trusted CAs.
 * settings.useSystemCertificates (default true) also trusts the CAs installed on this computer
 *   (macOS Keychain, Windows certificate store, Linux system bundle), as browsers do.
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
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, data: fs.readFileSync(file) };
  fileCache.set(file, entry);
  return entry;
}

// The CAs installed on this computer that Node doesn't already trust. Re-read every few minutes.
let systemProvider = () => (typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : []);
let systemCache = null;
function systemCertificates() {
  if (systemCache && Date.now() - systemCache.at < 5 * 60 * 1000) return systemCache.certs;
  let certs = [];
  try {
    const bundled = new Set(tls.rootCertificates);
    certs = systemProvider().filter((pem) => !bundled.has(pem));
  } catch { /* no system store on this platform */ }
  systemCache = { at: Date.now(), certs };
  return certs;
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

// Building a TLS context parses every CA (about 3 ms) and decrypts keys, so contexts are reused
// until a file, passphrase or the system store changes.
const contextCache = new Map();

/**
 * The TLS options for a URL: { secureContext, label } or null when Node's defaults apply.
 * label describes the client certificate used, for the timeline.
 */
function tlsFor(url, settings = {}) {
  if (new URL(url).protocol !== 'https:') return null;
  const parts = {};
  const keyParts = [];
  const cert = findCertificate(settings.certificates, url);
  if (cert) {
    const files = { pfx: cert.pfx && readFile(cert.pfx, 'PFX file'), cert: cert.crt && readFile(cert.crt, 'certificate file'), key: cert.key && readFile(cert.key, 'key file') };
    if (!files.pfx && !(files.cert && files.key)) {
      throw Object.assign(new Error(`The client certificate for ${cert.host} needs a CRT and KEY file, or a PFX file.`), { code: 'ECERTFILE' });
    }
    for (const [k, f] of Object.entries(files)) {
      if (!f) continue;
      parts[k] = f.data;
      keyParts.push(k, cert[k === 'cert' ? 'crt' : k], f.mtimeMs, f.size);
    }
    if (cert.passphrase) parts.passphrase = cert.passphrase;
    keyParts.push('pass', cert.passphrase || '');
  }
  const extra = [];
  const ca = settings.caCertificate;
  if (ca && ca.enabled !== false && ca.path) {
    const f = readFile(ca.path, 'CA certificate file');
    extra.push(f.data.toString('utf8'));
    keyParts.push('ca', ca.path, f.mtimeMs, f.size);
  }
  if (settings.useSystemCertificates !== false) {
    const sys = systemCertificates();
    if (sys.length) {
      extra.push(...sys);
      keyParts.push('system', sys.length, systemCache.at);
    }
  }
  // Node's "ca" replaces the built-in roots, so keep them alongside the extra certificates.
  if (extra.length) parts.ca = [...tls.rootCertificates, ...extra];
  if (!Object.keys(parts).length) return null;

  const cacheKey = JSON.stringify(keyParts);
  let secureContext = contextCache.get(cacheKey);
  if (!secureContext) {
    secureContext = tls.createSecureContext(parts);
    if (contextCache.size > 50) contextCache.clear();
    contextCache.set(cacheKey, secureContext);
  }
  return { secureContext, label: cert ? cert.host + (cert.port ? `:${cert.port}` : '') : null };
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

// For tests: replaces where the system store's certificates come from.
function setSystemProvider(fn) {
  systemProvider = fn;
  systemCache = null;
}

module.exports = { tlsFor, findCertificate, hostMatches, fromNewmanList, systemCertificates, setSystemProvider };
