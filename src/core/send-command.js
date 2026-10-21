'use strict';

/**
 * `httpdash send`: a curl-like command that sends through the HttpDash app running on this
 * computer (its AI access API), so a request uses the app's environments, {{variables}}, auth and
 * automatic login, cookies, certificates and tunnels, is logged there, and can be kept in a
 * collection when it works.
 *
 *   httpdash send [METHOD] <url> [-H 'Name: value']... [-d data | --json data] [-e env]
 *                 [-c collection] [--folder path] [--save | --save-always] [--name n] [-t tag]...
 *                 [-i] [-v] [-f]
 *
 * Exit codes: 0 an answer came back (any status, as curl), 22 with -f and a status of 400 or more,
 * 1 the request itself failed (connection, DNS, timeout), 2 bad arguments, 3 HttpDash wasn't
 * reachable or refused (not running, AI access off, a permission off, locked).
 */
const fs = require('fs');
const path = require('path');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const USAGE = `Usage: httpdash send [METHOD] <url> [options]

Sends through the HttpDash app on this computer (turn on Settings → AI access, with Run; Edit to save).
The URL may use {{variables}} from the environment.

  -X, --request <method>     Method (default GET, or POST with a body)
  -H, --header 'Name: value' Header (repeatable)
  -d, --data <text|@file>    Body; JSON is sent as application/json
      --json <text|@file>    JSON body, with Content-Type and Accept set to application/json
  -e, --environment <name>   Environment to use instead of the active one
  -c, --collection <name>    Run it in this collection, with its auth and automatic login
      --folder <path>        Folder in the collection, e.g. "Orders/Admin"
      --save                 Keep it in the collection and folder when it succeeds (2xx/3xx)
      --save-always          Keep it whatever it answers
      --name <name>          Name for the saved request
  -t, --tag <tag>            Tag for the saved request (repeatable); "ai" is always added
  -i, --include              Print the status line and headers before the body
  -v, --verbose              Print timing, instance, health and network details to stderr
  -f, --fail                 Exit with 22 when the status is 400 or more
      --max-body <bytes>     Cut the body at this size (default 1000000)
      --data-dir <dir>       HttpDash's data folder, if not the default
`;

class UsageError extends Error { constructor(m) { super(m); this.exitCode = 2; } }

function parseSendArgs(argv) {
  const o = { headers: [], tags: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '-X': case '--request': o.method = val().toUpperCase(); break;
      case '-H': case '--header': o.headers.push(val()); break;
      case '-d': case '--data': case '--data-raw': o.data = val(); break;
      case '--json': o.json = val(); break;
      case '-e': case '--environment': o.environment = val(); break;
      case '-c': case '--collection': o.collection = val(); break;
      case '--folder': o.folder = val(); break;
      case '--save': o.save = true; break;
      case '--save-always': o.save = true; o.saveAlways = true; break;
      case '--name': o.name = val(); break;
      case '-t': case '--tag': o.tags.push(val()); break;
      case '-i': case '--include': o.include = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '-f': case '--fail': o.fail = true; break;
      case '--max-body': o.maxBody = Number(val()); break;
      case '--data-dir': o.dataDir = val(); break;
      case '--port': o.port = Number(val()); break;
      case '--token': o.token = val(); break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`Unknown option ${a}`);
        o.positional.push(a);
    }
  }
  if (o.help) return o;
  if (o.positional.length && METHODS.has(o.positional[0].toUpperCase()) && o.positional.length > 1) o.method = o.method || o.positional.shift().toUpperCase();
  o.url = o.positional.shift();
  if (!o.url) throw new UsageError('Give the URL to send to');
  if (o.positional.length) throw new UsageError(`Unexpected ${o.positional[0]}`);
  if (o.data !== undefined && o.json !== undefined) throw new UsageError('Use -d or --json, not both');
  if ((o.folder || o.save) && !o.collection && o.folder) throw new UsageError('--folder needs --collection');
  return o;
}

const readValue = (v) => (v.startsWith('@') ? fs.readFileSync(path.resolve(v.slice(1)), 'utf8') : v);
const looksJson = (s) => { try { JSON.parse(s); return /^\s*[[{]/.test(s); } catch { return false; } };

/** The body of POST /send for these options. */
function sendBody(o, environmentId) {
  const headers = o.headers.map((h) => {
    const i = h.indexOf(':');
    if (i < 1) throw new UsageError(`A header is written "Name: value", not "${h}"`);
    return { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
  });
  const has = (name) => headers.some((h) => h.key.toLowerCase() === name);
  let body;
  if (o.json !== undefined) {
    body = { mode: 'raw', raw: readValue(o.json), rawLanguage: 'json' };
    if (!has('content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
    if (!has('accept')) headers.push({ key: 'Accept', value: 'application/json' });
  } else if (o.data !== undefined) {
    const raw = readValue(o.data);
    const json = looksJson(raw);
    body = { mode: 'raw', raw, rawLanguage: json ? 'json' : 'text' };
    if (!has('content-type')) headers.push({ key: 'Content-Type', value: json ? 'application/json' : 'application/x-www-form-urlencoded' });
  }
  const method = o.method || (body ? 'POST' : 'GET');
  return {
    request: { method, url: o.url, headers, ...(body ? { body } : {}) },
    ...(environmentId ? { environmentId } : {}),
    ...(o.collection ? { collection: o.collection } : {}),
    ...(o.folder ? { folder: o.folder } : {}),
    ...(o.save ? { save: true, saveIf: o.saveAlways ? 'always' : 'success' } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.tags.length ? { tags: o.tags } : {}),
    maxBodyBytes: o.maxBody > 0 ? o.maxBody : 1000000,
  };
}

/**
 * Runs the command. deps: { call(method, pathAndQuery, body) -> { status, json, text } } talks to
 * the app; io: { out, err, write } (write: raw stdout, for the body).
 */
async function runSend(argv, io, deps) {
  let o;
  try { o = parseSendArgs(argv); } catch (e) { io.err(e.message); io.err(USAGE); return e.exitCode || 2; }
  if (o.help) { io.out(USAGE); return 0; }

  const call = async (method, p, body) => {
    let r;
    try { r = await deps.call(method, p, body, o); } catch (e) {
      const why = e.code === 'ENOENT' ? 'HttpDash has not set up AI access on this computer yet' : e.code === 'ECONNREFUSED' ? 'HttpDash is not running, or AI access is off' : e.message;
      throw Object.assign(new Error(`${why}. Open HttpDash and turn on Settings → AI access (with the Run permission).`), { exitCode: 3 });
    }
    if (r.status >= 400) throw Object.assign(new Error((r.json && r.json.error) || `HttpDash answered ${r.status}`), { exitCode: 3 });
    return r.json;
  };

  try {
    let environmentId;
    if (o.environment) {
      const list = (await call('GET', '/environments')).items || [];
      const env = list.find((e) => e.id === o.environment) || list.find((e) => e.name.toLowerCase() === o.environment.toLowerCase());
      if (!env) throw Object.assign(new Error(`No environment "${o.environment}" (there are: ${list.map((e) => e.name).join(', ') || 'none'})`), { exitCode: 2 });
      environmentId = env.id;
    }
    const body = sendBody(o, environmentId);
    if (o.verbose) io.err(`> ${body.request.method} ${body.request.url}${o.collection ? `  (in ${o.collection}${o.folder ? ` / ${o.folder}` : ''})` : ''}`);
    const res = await call('POST', '/send', body);
    const r = res.response;
    if (o.verbose || res.error) {
      if (res.sent) io.err(`> sent to ${res.sent.url}`);
      if (res.instances) for (const x of res.instances) io.err(`> instance ${x.instance}${x.servedBy ? ` (answered by ${x.servedBy})` : ''}`);
    }
    if (res.error) { io.err(`Error: ${res.error}`); return 1; }
    if (o.include) {
      io.out(`HTTP ${r.status} ${r.statusText || ''}`.trim());
      for (const [k, v] of r.headers || []) io.out(`${k}: ${v}`);
      io.out('');
    }
    io.write(r.body || '');
    if (r.body && !r.body.endsWith('\n')) io.write('\n');
    if (r.bodyTruncated) io.err(`(body cut at ${body.maxBodyBytes} of ${r.bodyLength} bytes; use --max-body)`);
    if (o.verbose) {
      io.err(`< ${r.status} ${r.statusText || ''} in ${r.time} ms, ${r.size} bytes`);
      if (res.network && res.network.connected) io.err(`< from ${res.network.connected.address} (${res.network.connected.segment})`);
      if (res.network && res.network.tunnel) io.err(`< through the tunnel "${res.network.tunnel}"`);
      if (res.health) io.err(`< health: ${res.health.summary}`);
      if (res.testsSummary && (res.testsSummary.passed || res.testsSummary.failed)) io.err(`< tests: ${res.testsSummary.passed} passed, ${res.testsSummary.failed} failed`);
    }
    if (res.saved) io.err(res.saved.kept ? `Saved in ${res.saved.path} as "${res.saved.name}" (${res.saved.created ? 'new' : 'updated'})` : `Not saved: ${res.saved.reason}`);
    if (o.fail && r.status >= 400) return 22;
    return 0;
  } catch (e) {
    io.err(e.message);
    return e.exitCode || 1;
  }
}

/** Talks to the app's AI access API: the port and token from ai-access.json, unless given. */
function appCaller({ dataDir, request }) {
  return (method, pathAndQuery, body, o) => {
    let access = o.port && o.token ? { port: o.port, token: o.token } : null;
    if (!access) access = JSON.parse(fs.readFileSync(path.join(o.dataDir || dataDir, 'ai-access.json'), 'utf8'));
    return request({ port: access.port, token: access.token, method, pathAndQuery, body, client: 'httpdash send' });
  };
}

module.exports = { runSend, parseSendArgs, sendBody, appCaller, USAGE };
