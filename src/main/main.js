'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, safeStorage, session, net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { JsonStore } = require('./store');
const { execute, prepare, clientOptions } = require('../core/executor');
const health = require('../core/health');
const network = require('../core/network');
const { mergeScopes } = require('../core/variables');
const codegen = require('../core/codegen');
const { parseCurl } = require('../core/curl');
const postman = require('../core/postman');
const runner = require('../core/runner');
const { makeLookup } = require('../core/dependency');
const discovery = require('../core/discovery');
const openapiSync = require('../core/openapi-sync');
const balancer = require('../core/balancer');
const trafficReport = require('../core/traffic-report');
const payloads = require('../core/payloads');
const compareAnswers = require('../core/compare');
const dnsInstances = require('../core/dns-instances');
const requestShape = require('../core/request-shape');
const backup = require('../core/backup');
const { resolve: resolveVars } = require('../core/variables');
const httpClient = require('../core/http-client');
const { TunnelManager } = require('../core/tunnels');
const update = require('../core/update');
const { seedWorkspace } = require('./seed');

const dataDir = process.env.HTTPDASH_DATA_DIR || app.getPath('userData');
const workspaceStore = new JsonStore(path.join(dataDir, 'workspace.json'), seedWorkspace);
const cookieStore = new JsonStore(path.join(dataDir, 'cookies.json'), () => ({ cookies: [] }));
let jar = cookieStore.load().cookies;

// App lock (LDAP sign-in). The service-account password is encrypted with the OS keychain when available.
const { AppLock } = require('../core/app-lock');
const keychain = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : `b64:${Buffer.from(s).toString('base64')}`),
  decrypt: (s) => {
    const [kind, data] = [String(s).slice(0, 4), String(s).slice(4)];
    if (kind === 'enc:') return safeStorage.decryptString(Buffer.from(data, 'base64'));
    return Buffer.from(kind === 'b64:' ? data : String(s), 'base64').toString('utf8');
  },
};
const appLock = new AppLock({ file: path.join(dataDir, 'security.json'), secret: keychain });

// Local audit log, mock servers and the secret scanner.
const os = require('os');
const { AuditLog, safeTarget } = require('../core/audit');
const { startMockServer } = require('../core/mock');
const { scanWorkspace } = require('../core/secrets');
const audit = new AuditLog(path.join(dataDir, 'audit.log'), {
  user: () => appLock.status().lastUser || (() => { try { return os.userInfo().username; } catch { return ''; } })(),
});
audit.append('app.start', { version: app.getVersion(), platform: process.platform });
const mocks = new Map(); // collectionId -> { server, name }
const stopAllMocks = async () => {
  for (const [id, m] of mocks) {
    await m.server.close();
    audit.append('mock.stop', { collection: m.name, reason: 'locked' });
    mocks.delete(id);
  }
};
const saveJar = () => cookieStore.save({ cookies: jar });

let win;
const inflight = new Map();
let activeRun = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    title: 'HttpDash',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    // Shown on first paint, so the window opens fully drawn instead of as an empty frame.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const shown = win;
  const show = () => { if (!shown.isDestroyed() && !shown.isVisible()) shown.show(); };
  win.once('ready-to-show', show);
  setTimeout(show, 3000); // in case the page never paints, e.g. it failed to load
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the system browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block navigation away from the app; only reloading the app's own page is allowed (used by the lock).
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
}

function buildMenu() {
  const send = (cmd) => () => {
    // On macOS the app keeps running with no window; reopen one before dispatching.
    if (!win || win.isDestroyed()) {
      createWindow();
      win.webContents.once('did-finish-load', () => win.webContents.send('menu', cmd));
    } else win.webContents.send('menu', cmd);
  };
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: send('new-request') },
        { label: 'New Collection', click: send('new-collection') },
        { label: 'New Environment', click: send('new-environment') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: send('import') },
        { label: 'Save Request', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: send('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: send('close-tab') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: send('settings') },
        { label: 'Lock HttpDash', accelerator: 'CmdOrCtrl+L', registerAccelerator: false, click: send('lock') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      // Undo and redo keep their roles so every text field has them; in a request tab the window
      // takes the shortcut first and undoes the request's edits.
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []), { role: 'delete' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: send('find') },
        { label: 'Search Requests', accelerator: 'CmdOrCtrl+Shift+F', registerAccelerator: false, click: send('search-requests') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: send('toggle-sidebar') },
        { label: 'Toggle Console', accelerator: 'CmdOrCtrl+Alt+C', registerAccelerator: false, click: send('toggle-console') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', registerAccelerator: false, click: send('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false, click: send('prev-tab') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        // Zoom goes through the window's own steps and setting (Settings → Appearance), not Chromium's.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: send('zoom-reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: send('zoom-out') },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Send Request', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: send('send') },
        { label: 'Collection Runner', click: send('runner') },
        { label: 'Cookies', click: send('cookies') },
        { label: 'Generate Code', click: send('codegen') },
        { type: 'separator' },
        { label: 'Monitors', click: send('monitors') },
        { label: 'Scan for Secrets', click: send('secrets') },
        { label: 'Audit Log', click: send('audit') },
        { type: 'separator' },
        { label: 'Team Repositories', click: send('team') },
        { label: 'Sync with Team', click: send('team-sync') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => checkForUpdates() },
        { label: 'Release Notes', click: () => shell.openExternal('https://github.com/gethttpdash/httpdash/releases') },
        { type: 'separator' },
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/gethttpdash/httpdash/blob/main/USERGUIDE.md') },
        { label: 'Report an Issue', click: () => shell.openExternal('https://github.com/gethttpdash/httpdash/issues/new/choose') },
        { label: 'HttpDash Website', click: () => shell.openExternal('https://httpdash.com') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Asks GitHub for the latest release and tells the user whether it is newer than this build.
async function checkForUpdates() {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const current = app.getVersion();
  let result;
  try {
    const res = await net.fetch(update.RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `HttpDash/${current}` } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    result = update.checkRelease(await res.json(), current);
  } catch (err) {
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning', buttons: ['Open Releases Page', 'Close'], defaultId: 1,
      message: 'Couldn’t check for updates', detail: `${err.message}\n\nYou can check the releases page instead.`,
    });
    if (response === 0) shell.openExternal(update.RELEASES_PAGE);
    return;
  }
  if (!result.available) {
    await dialog.showMessageBox(parent, { type: 'info', buttons: ['OK'], message: 'HttpDash is up to date', detail: `You have version ${current}.` });
    return;
  }
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
    message: `HttpDash ${result.latest} is available`,
    detail: `You have version ${current}. Download the new version from GitHub; your collections, environments and settings carry over.`,
  });
  if (response === 0) shell.openExternal(result.url);
}

// ---- IPC ----------------------------------------------------------------------------------

// While HttpDash is locked, only the lock screen's channels answer; everything else is refused,
// so no workspace data reaches the window until an LDAP sign-in succeeds.
const OPEN_WHILE_LOCKED = new Set(['lock:status', 'lock:unlock', 'lock:recover', 'app:info']);
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  if (appLock.isLocked() && !OPEN_WHILE_LOCKED.has(channel)) throw new Error('HttpDash is locked');
  return fn(...args);
});

handle('lock:status', () => appLock.status());
handle('lock:getConfig', () => appLock.publicConfig());
// Runs fn and writes an audit entry for success or failure.
const audited = async (event, details, fn) => {
  try {
    const out = await fn();
    audit.append(event, { ...details, ok: true });
    return out;
  } catch (e) {
    audit.append(event, { ...details, ok: false, error: e.message });
    throw e;
  }
};
handle('lock:setConfig', (cfg) => audited('lock.settings', { url: cfg.url, mode: cfg.mode }, () => appLock.setConfig(cfg)));
handle('lock:test', async ({ username, password }) => {
  const r = await appLock.test(username, password);
  audit.append('lock.test', { username, ok: r.ok, error: r.error });
  return r;
});
handle('lock:enable', (opts) => audited('lock.enable', { allowedUsers: opts && opts.allowedUsers }, () => appLock.enable(opts)));
handle('lock:update', (opts) => audited('lock.update', opts || {}, () => appLock.updateLock(opts)));
handle('lock:lock', () => audited('lock.lock', {}, async () => { await stopAllMocks(); closeAllWebSockets('HttpDash was locked'); return appLock.lock(); }));
handle('lock:unlock', ({ username, password }) => audited('lock.unlock', { username }, () => appLock.unlock(username, password)));
handle('lock:recover', (code) => audited('lock.recover', {}, () => appLock.recover(code)));
handle('lock:disable', ({ username, password }) => audited('lock.disable', { username }, () => appLock.disable(username, password)));

// Tunnels into internal networks (tunnels.js): every connection the app makes asks the manager
// which tunnel, if any, its URL goes through. The workspace says which tunnels exist and which one
// the active environment uses.
const tunnels = new TunnelManager({ onStatus: (list) => { if (win && !win.isDestroyed()) win.webContents.send('tunnels:status', list); } });
httpClient.setRouter((url, o) => tunnels.socksFor(url, o));
const configureTunnels = (ws) => {
  if (!ws) return;
  const env = (ws.environments || []).find((e) => e.id === ws.activeEnvironmentId);
  tunnels.configure({ tunnels: ws.tunnels || [], envTunnelId: env && env.tunnelId ? env.tunnelId : undefined });
};
handle('workspace:load', () => { const ws = workspaceStore.load(); configureTunnels(ws); return ws; });
handle('workspace:save', (data) => { workspaceStore.save(data); configureTunnels(data); return true; });
handle('tunnels:status', () => tunnels.status());
handle('tunnels:stop', ({ id }) => { tunnels.stop(id); return tunnels.status(); });
// Opens a tunnel (an SSH one is started) and, through it, connects to a host when one is given.
handle('tunnels:test', async ({ id, target }) => {
  const t = tunnels.tunnels.find((x) => x.id === id);
  if (!t) throw new Error('No such tunnel');
  const started = Date.now();
  const socks = t.type === 'socks5'
    ? { host: (t.socks || {}).host, port: Number((t.socks || {}).port) || 1080, username: (t.socks || {}).username, password: (t.socks || {}).password, label: t.name }
    : { host: '127.0.0.1', port: await tunnels.start(t), label: t.name };
  if (!target) {
    if (t.type === 'socks5') await new Promise((resolve, reject) => { const s = require('net').connect(socks.port, socks.host); s.setTimeout(10000, () => { s.destroy(); reject(new Error(`No answer from ${socks.host}:${socks.port}`)); }); s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', (e) => reject(new Error(`Could not reach ${socks.host}:${socks.port}: ${e.message}`))); });
    return { ok: true, ms: Date.now() - started, status: tunnels.status() };
  }
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(target).trim());
  if (!m) throw new Error('Write the host to try as host:port');
  const sock = await httpClient.socksConnect(socks, { host: m[1], port: Number(m[2] || 443) }, 15000);
  sock.destroy();
  return { ok: true, ms: Date.now() - started, status: tunnels.status() };
});
handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir, dark: nativeTheme.shouldUseDarkColors }));

handle('request:send', async ({ id, request, chain, scopes, settings, info, collection }) => {
  const controller = new AbortController();
  inflight.set(id, controller);
  const logs = [];
  // Server-Sent Events go to the window in small batches while the response streams in.
  let queue = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (queue.length && win && !win.isDestroyed()) win.webContents.send('request:stream', { id, events: queue });
    queue = [];
  };
  try {
    const res = await execute({
      request, chain, scopes, settings, info, jar,
      lookup: makeLookup(collection),
      signal: controller.signal,
      log: (level, message) => logs.push({ level, message, time: Date.now() }),
      onStream: (ev) => { queue.push(ev); if (!flushTimer) flushTimer = setTimeout(flush, 50); },
    });
    res.logs = logs;
    audit.append('request.send', {
      name: info && info.requestName, method: res.sentRequest ? res.sentRequest.method : request.method,
      target: safeTarget(res.sentRequest ? res.sentRequest.url : request.url),
      status: res.response ? res.response.status : undefined, error: res.error || undefined,
      authDependency: res.dependencyRuns && res.dependencyRuns.length ? res.dependencyRuns.map((d) => d.name) : undefined,
    });
    return res;
  } finally {
    clearTimeout(flushTimer);
    flush();
    inflight.delete(id);
    saveJar();
  }
});
// Compare instances: the same request, once to each healthy instance of a discovered service, and
// the answers compared (see compare.js). Every call sends the same payload. Variable changes made
// by scripts are thrown away, except a token an auth dependency saved: the first instance goes
// alone, so a login runs once, and the others use what it saved.
const COMPARE_MAX_INSTANCES = 50;
const COMPARE_BODY_LIMIT = 1024 * 1024;
// The request's URL with its variables filled in, as it would be sent.
const resolvedUrl = (request, scopes) => resolveVars(String(request.url || ''), Object.assign({}, scopes.globals, scopes.collection, scopes.environment, scopes.data));
const proxyApplies = (settings, url) => {
  const p = settings && settings.proxy;
  if (!p || !p.enabled || !p.host) return false;
  try { return !httpClient.matchesBypass(new URL(url).hostname, p.bypass); } catch { return false; }
};
// Reads a health endpoint once, for "Read it now" in the health settings: every field it gives.
// A path is read on the origin of `request` (the request itself, or one in the folder).
handle('health:read', async ({ cfg, request, chain, scopes, settings }) => {
  const s = settings || {};
  const vars = mergeScopes(scopes || {});
  let prepared = null;
  try { if (request && request.url) prepared = prepare(request, { chain: chain || [], vars, settings: s, jar }); } catch { prepared = null; }
  const url = health.healthUrl(cfg || {}, vars, prepared ? prepared.url : '');
  if (!/^https?:\/\//i.test(url)) return { url, error: url.startsWith('/') ? 'A path needs a request to read it on: add a request here first, or enter a full URL' : 'Enter a full URL, or a path such as /healthz' };
  const headers = cfg && cfg.sendAuth && prepared ? prepared.headers.filter(([k]) => k.toLowerCase() === 'authorization') : [];
  const r = await health.read({ url, base: prepared ? clientOptions(prepared, s, jar) : { verifySSL: s.verifySSL !== false, proxy: s.proxy }, headers });
  return { url, ...r };
});

// The route to a host, with the system's traceroute: [{ hop, address, ms, segment, kind, ... }].
handle('network:traceroute', ({ host }) => network.traceRoute(host));

// Whether a plain URL has instances in DNS (several addresses for its host): { host, addresses } or null.
handle('dns:instances', async ({ request, scopes, settings }) => {
  const url = resolvedUrl(request, scopes || {});
  if (proxyApplies(settings, url)) return null;
  const found = await dnsInstances.instancesFor(url);
  return found && { host: found.host, addresses: found.addresses };
});

// Instances are either a discovered service's (`variable`) or the addresses DNS gives the URL's host (`dns`).
handle('request:compare', async ({ request, chain, scopes, settings, info, collection, variable, dns: byDns }) => {
  const pools = scopes.pools || {};
  let instances;
  let service;
  if (byDns) {
    const url = resolvedUrl(request, scopes);
    if (proxyApplies(settings, url)) throw new Error('A proxy is in use, and it picks the address of the host itself. Compare by DNS needs a direct connection.');
    const found = await dnsInstances.instancesFor(url, { fresh: true });
    if (!found) throw new Error('The host no longer resolves to several addresses: nothing to compare');
    service = found.host;
    const show = (a) => (found.family === 6 ? `[${a}]` : a);
    instances = found.addresses.slice(0, COMPARE_MAX_INSTANCES).map((address) => ({
      url: `${found.protocol}//${show(address)}:${found.port}`, id: address, connectTo: { host: found.host, address, family: found.family },
    }));
  } else {
    const pool = pools[variable];
    if (!pool) throw new Error(`{{${variable}}} is not a variable from service discovery, or it was changed by hand`);
    service = pool.service;
    instances = (pool.instances || []).filter((i) => i.url && i.healthy !== false).slice(0, COMPARE_MAX_INSTANCES);
    if (instances.length < 2) throw new Error(`${pool.service} has ${instances.length} healthy instance${instances.length === 1 ? '' : 's'}: nothing to compare`);
  }
  const chosen = payloads.choose(request, { key: (info && info.requestId) || `${request.method} ${request.url}`, index: info && info.payloadIndex });
  const lookup = makeLookup(collection);
  const runOne = (inst, baseScopes) => execute({
    request, chain, settings, jar, lookup,
    scopes: inst.connectTo ? JSON.parse(JSON.stringify(baseScopes))
      : { ...JSON.parse(JSON.stringify({ ...baseScopes, pools: undefined })), pools: { ...pools, [variable]: { ...pools[variable], force: inst.url } } },
    connectTo: inst.connectTo,
    info: { ...(info || {}), payloadIndex: chosen ? chosen.index : undefined },
    log: () => {},
  });
  const first = await runOne(instances[0], scopes);
  const savedScopes = first.dependencyRuns && first.dependencyRuns.some((d) => d.stored && Object.keys(d.stored).length) ? first.scopes : null;
  const rest = [];
  for (let i = 1; i < instances.length; i += 8) {
    rest.push(...await Promise.all(instances.slice(i, i + 8).map((inst) => runOne(inst, savedScopes ? { ...scopes, ...savedScopes } : scopes))));
  }
  const raw = [first, ...rest];
  const results = raw.map((r, i) => ({ instance: instances[i].url, instanceId: instances[i].id || '', response: r.response || null, error: r.error || null, tests: r.tests || [] }));
  const comparison = compareAnswers.compare(results, (request.compare || {}));
  audit.append('request.compare', { name: info && info.requestName, service, by: byDns ? 'dns' : 'discovery', instances: instances.length, odd: comparison.differences.filter((d) => d.kind === 'odd').length });
  // What goes back to the window: every instance's full result, with very large bodies cut.
  return {
    variable: byDns ? null : variable, dns: !!byDns, service, comparison, savedScopes,
    results: raw.map((r, i) => {
      const response = r.response && r.response.bodyText && r.response.bodyText.length > COMPARE_BODY_LIMIT
        ? { ...r.response, bodyText: r.response.bodyText.slice(0, COMPARE_BODY_LIMIT), truncated: true } : r.response;
      return { ...r, scopes: undefined, response, instance: instances[i].url, instanceId: instances[i].id || '' };
    }),
  };
});
// Compares answers again, e.g. after a path was ignored.
// Whether a request still fits its operation in an OpenAPI source's spec.
handle('shape:check', ({ def, shapes, op, variable }) => {
  const found = requestShape.findShape(def || {}, shapes, { op, variable });
  if (!found) return null;
  return { key: found.key, missing: !found.shape, issues: found.shape ? requestShape.checkRequest(def || {}, found.shape) : [] };
});
handle('compare:answers', ({ results, ignore }) => compareAnswers.compare(results, ignore || {}));

handle('request:cancel', (id) => { const c = inflight.get(id); if (c) c.abort(); return !!c; });

// ---- WebSocket ----------------------------------------------------------------------------------
// One connection per tab. The handshake is prepared like an HTTP request (variables, inherited
// auth, cookies), then messages stream to the window as 'ws:event'.
const wsConnections = new Map(); // tab id -> connection
const certificates = require('../core/certificates');
const websocket = require('../core/websocket');
const wsEmit = (id, evt) => { if (win && !win.isDestroyed()) win.webContents.send('ws:event', { id, time: Date.now(), ...evt }); };
const closeAllWebSockets = (reason) => { for (const c of wsConnections.values()) c.close(1001, reason); };

handle('ws:connect', async ({ id, request, chain, scopes, settings }) => {
  const old = wsConnections.get(id);
  if (old) { old.removeAllListeners(); old.close(1000, 'Reconnecting'); wsConnections.delete(id); }
  const s = settings || {};
  const vars = mergeScopes(scopes || {});
  // prepare() resolves variables, auth and cookies for the http(s) form of the URL.
  const wsUrl = resolveVars(String(request.url || ''), vars).trim();
  if (!/^wss?:\/\//i.test(wsUrl)) throw new Error('WebSocket URLs start with ws:// or wss://');
  const prepared = prepare({ ...request, method: 'GET', body: { mode: 'none' }, url: wsUrl.replace(/^ws/i, 'http') }, { chain, vars, settings: s, jar, defaultHeaders: false });
  if (!prepared.headers.some(([k]) => k.toLowerCase() === 'user-agent')) prepared.headers.push(['User-Agent', s.userAgent || 'HttpDash/1.0']);
  const url = prepared.url.replace(/^http/i, 'ws');
  const protocols = String((request.ws && request.ws.protocols) || '').split(',').map((p) => p.trim()).filter(Boolean);
  let conn;
  try {
    conn = await websocket.connect({
      url, headers: prepared.headers, protocols, timeout: s.timeout || 30000, verifySSL: s.verifySSL !== false, proxy: s.proxy, tunnelId: s.tunnelId,
      tlsFor: (u) => certificates.tlsFor(u, s),
    });
  } catch (e) {
    audit.append('ws.connect', { target: safeTarget(url), error: e.message });
    throw Object.assign(new Error(e.message), { status: e.status });
  }
  wsConnections.set(id, conn);
  audit.append('ws.connect', { target: safeTarget(url), status: 101 });
  conn.on('message', (m) => wsEmit(id, { type: 'message', dir: 'in', binary: m.binary, size: m.size, data: m.binary ? m.data.toString('base64') : m.data }));
  conn.on('ping', () => wsEmit(id, { type: 'ping' }));
  conn.on('error', (e) => wsEmit(id, { type: 'error', message: e.message }));
  conn.on('close', (c) => { if (wsConnections.get(id) === conn) wsConnections.delete(id); wsEmit(id, { type: 'close', ...c }); });
  return { url, handshake: conn.handshake };
});
handle('ws:send', ({ id, text, scopes }) => {
  const conn = wsConnections.get(id);
  if (!conn) throw new Error('Not connected');
  const data = resolveVars(String(text), mergeScopes(scopes || {}));
  const size = conn.send(data);
  return { data, size };
});
handle('ws:close', ({ id, code, reason }) => { const conn = wsConnections.get(id); if (conn) conn.close(code || 1000, reason || ''); return !!conn; });

handle('codegen:targets', () => codegen.targets());
handle('codegen:generate', ({ target, request, chain, scopes }) => {
  const p = prepare(request, { chain, vars: mergeScopes(scopes), defaultHeaders: false });
  return codegen.generate(target, p, request);
});

handle('import:curl', (text) => parseCurl(text));
handle('import:text', (text) => postman.importText(text));
// Imports from a link (an OpenAPI spec, a Postman collection...), fetched with the user's proxy,
// certificates and SSL settings.
handle('import:url', async ({ url, token, settings }) => {
  const s = settings || {};
  if (!/^https?:\/\//i.test(String(url || '').trim())) throw new Error('Enter an http:// or https:// link');
  const res = await httpClient.send({
    method: 'GET', url: String(url).trim(), followRedirects: true, timeout: s.timeout || 30000, verifySSL: s.verifySSL !== false, proxy: s.proxy,
    headers: [['Accept', 'application/json, application/yaml, text/yaml, */*'], ['User-Agent', s.userAgent || 'HttpDash/1.0'],
      ...(token ? [['Authorization', `Bearer ${String(token).trim().replace(/^Bearer\s+/i, '')}`]] : [])],
    maxSize: 50 * 1024 * 1024, tlsFor: (u) => certificates.tlsFor(u, s),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`The link answered ${res.status} ${res.statusText}: it needs ${token ? 'a different' : 'a'} token. Enter it in the Bearer token field.`);
  }
  if (res.status >= 400) throw new Error(`The link answered ${res.status} ${res.statusText}`);
  const r = postman.importText(res.body.toString('utf8'));
  audit.append('import.url', { target: safeTarget(url), kind: r.kind });
  return { ...r, file: url };
});
handle('import:files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Collections, environments, OpenAPI', extensions: ['json', 'yaml', 'yml'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled) return [];
  const items = r.filePaths.map((f) => {
    try {
      return { file: path.basename(f), ...postman.importText(fs.readFileSync(f, 'utf8')) };
    } catch (e) {
      return { file: path.basename(f), error: e.message };
    }
  });
  audit.append('import.files', { files: items.map((i) => `${i.file} (${i.error ? 'error' : i.kind})`) });
  return items;
});

async function saveJson(defaultName, data) {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
}
const safeName = (s) => String(s || 'export').replace(/[^\w.-]+/g, '_');
handle('export:collection', (col) => saveJson(`${safeName(col.name)}.postman_collection.json`, postman.exportCollection(col)));
handle('export:environment', (env) => saveJson(`${safeName(env.name)}.postman_environment.json`, postman.exportEnvironment(env)));
handle('export:globals', (values) => saveJson('globals.postman_globals.json', { ...postman.exportEnvironment({ id: 'globals', name: 'Globals', values }), _postman_variable_scope: 'globals' }));
handle('export:json', ({ name, data }) => saveJson(name, data));
// Table view exports: records become a CSV file or an Excel workbook; images arrive as PNG data.
const tabular = require('../core/tabular');
handle('table:export', async ({ format, name, records }) => {
  const base = safeName(name || 'table');
  const xlsx = format === 'xlsx';
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `${base}.${xlsx ? 'xlsx' : 'csv'}`,
    filters: [xlsx ? { name: 'Excel workbook', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const table = tabular.flatten(records || []);
  // CSV gets a byte-order mark so Excel reads it as UTF-8.
  fs.writeFileSync(r.filePath, xlsx ? tabular.toXlsx(table, { sheetName: name || 'Data' }) : `\uFEFF${tabular.toCsv(table)}`);
  return r.filePath;
});
handle('table:flatten', ({ records }) => tabular.flatten(records || []));
handle('file:savePng', async ({ name, base64 }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `${safeName(name || 'table')}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(base64, 'base64'));
  return r.filePath;
});
// A discovery source's traffic report, in the chosen format. PDF and PNG are made from the report's
// HTML page in a hidden, sandboxed window (no scripts in the page, no Node, no preload).
const REPORT_FORMATS = {
  csv: ['CSV', 'csv'], xlsx: ['Excel workbook', 'xlsx'], json: ['JSON', 'json'], md: ['Markdown', 'md'],
  html: ['HTML page', 'html'], pdf: ['PDF', 'pdf'], png: ['PNG image', 'png'],
};
async function renderReportPage(html, fn) {
  const page = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  page.webContents.on('will-navigate', (e) => e.preventDefault());
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await fn(page);
  } finally {
    page.destroy();
  }
}
handle('report:export', async ({ format, name, report: input }) => {
  const kind = REPORT_FORMATS[format];
  if (!kind) throw new Error(`Unknown report format "${format}"`);
  const report = trafficReport.normalize(input || {});
  const r = await dialog.showSaveDialog(win, { defaultPath: `${safeName(name || 'traffic-report')}.${kind[1]}`, filters: [{ name: kind[0], extensions: [kind[1]] }] });
  if (r.canceled || !r.filePath) return null;
  let data;
  if (format === 'csv') data = trafficReport.toCsv(report);
  else if (format === 'xlsx') data = trafficReport.toXlsx(report);
  else if (format === 'json') data = trafficReport.toJson(report);
  else if (format === 'md') data = trafficReport.toMarkdown(report);
  else if (format === 'html') data = trafficReport.toHtml(report);
  else if (format === 'pdf') data = await renderReportPage(trafficReport.toHtml(report), (page) => page.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: true }));
  else {
    data = await renderReportPage(trafficReport.toHtml(report), async (page) => {
      // The image is as tall as the report.
      const height = await page.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
      page.setContentSize(1100, Math.min(Math.max(height, 200), 8000));
      await new Promise((res) => setTimeout(res, 150));
      return (await page.webContents.capturePage()).toPNG();
    });
  }
  fs.writeFileSync(r.filePath, data);
  return r.filePath;
});

// Export everything: a restorable HttpDash backup, or a folder of Postman collection/environment files.
handle('export:all', async ({ workspace, format, excludeSecrets }) => {
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'backup') {
    const data = backup.makeBackup(workspace, jar, { excludeSecrets, appVersion: app.getVersion() });
    const file = await saveJson(`httpdash-backup-${date}.json`, data);
    if (file) audit.append('export.all', { format, secretsIncluded: !excludeSecrets, path: file });
    return file ? { path: file, files: 1 } : null;
  }
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the Postman files', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const ws = JSON.parse(JSON.stringify(workspace));
  if (excludeSecrets) backup.stripSecrets(ws);
  const dir = path.join(r.filePaths[0], `httpdash-export-${date}`);
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set();
  const write = (base, data) => {
    let name = `${base}.json`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = base.replace(/(\.postman_\w+)$/, `-${i}$1`) + '.json';
    used.add(name.toLowerCase());
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  };
  for (const col of ws.collections || []) write(`${safeName(col.name)}.postman_collection`, postman.exportCollection(col));
  for (const env of ws.environments || []) write(`${safeName(env.name)}.postman_environment`, postman.exportEnvironment(env));
  if ((ws.globals || []).some((g) => g.key)) {
    write('globals.postman_globals', { ...postman.exportEnvironment({ id: 'globals', name: 'Globals', values: ws.globals }), _postman_variable_scope: 'globals' });
  }
  audit.append('export.all', { format, secretsIncluded: !excludeSecrets, path: dir, files: used.size });
  return { path: dir, files: used.size };
});

handle('backup:restore', ({ current, data, mode }) => {
  const res = backup.restore(current, data, mode);
  audit.append('import.backup', { mode, collections: res.added.collections, environments: res.added.environments });
  if (res.cookies) {
    jar = mode === 'replace' ? res.cookies : backup.mergeCookies(jar, res.cookies);
    saveJar();
  }
  delete res.cookies;
  return res;
});

handle('response:save', async ({ name, bodyText, bodyBase64 }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name || 'response' });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, bodyBase64 ? Buffer.from(bodyBase64, 'base64') : bodyText || '');
  return r.filePath;
});

handle('dialog:openFile', async ({ multi, filters } = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters });
  return r.canceled ? [] : r.filePaths;
});
handle('payloads:fromRows', (rows) => payloads.fromRows(rows));
handle('runner:readData', (file) => {
  const rows = runner.parseDataFile(fs.readFileSync(file, 'utf8'), file);
  return { file: path.basename(file), rows };
});

handle('runner:start', async (opts) => {
  if (activeRun) throw new Error('A collection run is already in progress');
  const controller = new AbortController();
  activeRun = controller;
  try {
    const summary = await runner.run({
      ...opts,
      resetPayloads: true,
      jar: opts.useCookies === false ? [] : jar,
      signal: controller.signal,
      onEvent: (evt) => win && !win.isDestroyed() && win.webContents.send('runner:event', evt),
    });
    audit.append('runner.run', { collection: opts.collection && opts.collection.name, requests: summary.requests, passed: summary.passed, failed: summary.failed, errors: summary.failedRequests });
    return summary;
  } finally {
    activeRun = null;
    saveJar();
  }
});
handle('runner:stop', () => { if (activeRun) activeRun.abort(); return true; });

// Monitors run independently of the interactive runner (they may overlap with it).
handle('monitor:run', async (opts) => {
  const summary = await runner.run({ ...opts, jar: opts.useCookies === false ? [] : jar });
  saveJar();
  audit.append('monitor.run', { monitor: opts.monitorName, collection: opts.collection && opts.collection.name, requests: summary.requests, failed: summary.failed, errors: summary.failedRequests });
  return { ...summary, results: summary.results.map((r) => ({ name: r.name, method: r.method, url: r.url, status: r.status, time: r.time, error: r.error, tests: r.tests.filter((t) => !t.passed).map((t) => ({ name: t.name, error: t.error })) })) };
});

handle('mock:start', async ({ collection, port, delayMs, lan }) => {
  const existing = mocks.get(collection.id);
  if (existing) { await existing.server.close(); mocks.delete(collection.id); }
  const server = await startMockServer({
    collection, port: Number(port) || 0, delayMs: Number(delayMs) || 0, host: lan ? '0.0.0.0' : '127.0.0.1',
    onRequest: (entry) => win && !win.isDestroyed() && win.webContents.send('mock:log', { collectionId: collection.id, ...entry }),
  });
  mocks.set(collection.id, { server, name: collection.name, lan: !!lan, delayMs: Number(delayMs) || 0 });
  audit.append('mock.start', { collection: collection.name, port: server.port, lan: !!lan });
  return { url: server.url, port: server.port };
});
handle('mock:update', ({ collection }) => {
  const m = mocks.get(collection.id);
  if (m) m.server.update(collection);
  return !!m;
});
handle('mock:stop', async (collectionId) => {
  const m = mocks.get(collectionId);
  if (!m) return false;
  await m.server.close();
  mocks.delete(collectionId);
  audit.append('mock.stop', { collection: m.name });
  return true;
});
handle('mock:list', () => [...mocks].map(([id, m]) => ({ collectionId: id, url: m.server.url, port: m.server.port, lan: m.lan, delayMs: m.delayMs })));

handle('secrets:scan', (workspace) => scanWorkspace(workspace));

handle('audit:read', (filter) => audit.read(filter || {}));
handle('audit:clear', () => { audit.clear(); audit.append('audit.clear', {}); return true; });
handle('audit:export', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `httpdash-audit-${new Date().toISOString().slice(0, 10)}.jsonl`, filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, audit.read({ limit: 1e9 }).reverse().map((e) => JSON.stringify(e)).join('\n') + '\n');
  audit.append('audit.export', { path: r.filePath });
  return r.filePath;
});

// ---- Team sync through a git repository --------------------------------------------------
// Clones live in <data>/team/<repoId>; access tokens are kept apart from the workspace, encrypted.
const { TeamRepo, sync: teamSync, finishConflicts } = require('../core/gitsync');
const repoFormat = require('../core/repo-format');
const teamDir = path.join(dataDir, 'team');
const teamTokens = new JsonStore(path.join(dataDir, 'team-tokens.json'), () => ({}));
const teamQueues = new Map(); // repoId -> promise, so operations on one repo never overlap
const queued = (repoId, fn) => {
  const run = (teamQueues.get(repoId) || Promise.resolve()).catch(() => {}).then(fn);
  teamQueues.set(repoId, run);
  return run;
};
const safeId = (id) => String(id || '').replace(/[^\w-]/g, '');
let gitIdentity;
// Commits use the person's own git identity; without one, their computer user name.
const identity = async () => {
  if (gitIdentity) return gitIdentity;
  const probe = new TeamRepo({ dir: os.tmpdir() });
  const name = (await probe.git(['config', '--get', 'user.name'], { cwd: os.tmpdir(), allowFail: true })).stdout.trim();
  gitIdentity = name ? {} : { userName: appLock.status().lastUser || (() => { try { return os.userInfo().username; } catch { return 'HttpDash user'; } })() };
  return gitIdentity;
};
const teamRepo = async (cfg) => {
  const id = safeId(cfg.id);
  if (!id || !cfg.url) throw new Error('The team repository needs a URL.');
  const stored = teamTokens.load()[id];
  return new TeamRepo({
    dir: path.join(teamDir, id), url: cfg.url, branch: cfg.branch || 'main', subdir: cfg.subdir,
    token: cfg.auth === 'token' && stored ? keychain.decrypt(stored.token) : '', username: (stored && stored.username) || 'oauth2',
    ...(await identity()),
  });
};
const teamAudited = (event, cfg, fn) => audited(event, { repo: safeTarget(cfg.url), branch: cfg.branch || 'main' }, fn);

handle('team:gitVersion', async () => {
  try { return { ok: true, version: await TeamRepo.version() }; } catch (e) { return { ok: false, error: e.message }; }
});
handle('team:setToken', ({ repoId, token, username }) => {
  const all = teamTokens.load();
  if (token) all[safeId(repoId)] = { token: keychain.encrypt(token), username: username || 'oauth2' };
  else delete all[safeId(repoId)];
  teamTokens.save(all);
  return true;
});
handle('team:tokenInfo', (repoId) => {
  const t = teamTokens.load()[safeId(repoId)];
  return t ? { saved: true, username: t.username } : { saved: false };
});
handle('team:sync', ({ repo, state, message, pullOnly }) => queued(repo.id, () => teamAudited(pullOnly ? 'team.pull' : 'team.sync', repo, async () => teamSync(await teamRepo(repo), state, { message, pullOnly }))));
handle('team:resolve', ({ repo, side, pullOnly }) => queued(repo.id, () => teamAudited('team.resolve', repo, async () => finishConflicts(await teamRepo(repo), side, { pullOnly }))));
handle('team:apply', ({ local, team, repoId, keepMissing }) => repoFormat.applyRepo(local, team, repoId, { keepMissing }));
handle('team:scan', (state) => scanWorkspace({ ...repoFormat.shareable(state), globals: [] }));
handle('team:abort', (repo) => queued(repo.id, async () => { await (await teamRepo(repo)).abortMerge(); return true; }));
handle('team:log', (repo) => queued(repo.id, async () => {
  const r = await teamRepo(repo);
  if (!fs.existsSync(path.join(r.dir, '.git'))) return [];
  return r.log(30);
}));
handle('team:remove', (repoId) => queued(repoId, () => {
  const all = teamTokens.load();
  delete all[safeId(repoId)];
  teamTokens.save(all);
  if (safeId(repoId)) fs.rmSync(path.join(teamDir, safeId(repoId)), { recursive: true, force: true });
  audit.append('team.remove', { repoId: safeId(repoId) });
  return true;
}));

handle('cookies:list', () => jar);
handle('cookies:delete', ({ name, domain, path: p }) => {
  jar = jar.filter((c) => !(c.name === name && c.domain === domain && (p === undefined || c.path === p)));
  saveJar();
  return jar;
});
handle('cookies:clearDomain', (domain) => { jar = jar.filter((c) => c.domain !== domain); saveJar(); return jar; });
handle('cookies:clear', () => { jar = []; saveJar(); return jar; });
handle('cookies:upsert', (cookie) => {
  jar = jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
  jar.push({ path: '/', hostOnly: false, secure: false, httpOnly: false, expires: null, ...cookie });
  saveJar();
  return jar;
});

// ---- OAuth 2.0 -------------------------------------------------------------------------------
// Sign-in grants open the provider's page in an HttpDash window and catch the redirect to the
// callback URL, so any registered callback works. With "use browser", the system browser signs in
// instead and the callback must be a port on this computer, where HttpDash listens (RFC 8252).

const oauth2 = require('../core/oauth2');
const OAUTH_PARTITION = 'persist:oauth2';
const OAUTH_BROWSER_TIMEOUT_MS = 5 * 60 * 1000;
let cancelSignIn = null;

const oauthConfig = (config, scopes) => {
  const vars = mergeScopes(scopes || {});
  const out = { ...config };
  for (const k of ['authUrl', 'accessTokenUrl', 'callbackUrl', 'clientId', 'clientSecret', 'scope', 'audience', 'username', 'password', 'refreshToken']) {
    out[k] = resolveVars(config[k] || '', vars).trim();
  }
  return out;
};

async function oauthTokenRequest(cfg, kind, extra, settings) {
  const req = oauth2.tokenRequest(cfg, kind, extra);
  const res = await httpClient.send({
    method: 'POST', url: req.url, headers: req.headers, body: req.body,
    timeout: (settings && settings.timeout) || 30000, verifySSL: !settings || settings.verifySSL !== false, followRedirects: true,
    proxy: settings && settings.proxy,
  });
  return oauth2.parseTokenResponse(res.status, res.body.toString('utf8'));
}

function signInWithWindow(url, callbackUrl) {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      parent: win && !win.isDestroyed() ? win : undefined,
      width: 520, height: 720, title: 'Sign in', autoHideMenuBar: true,
      webPreferences: { partition: OAUTH_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      cancelSignIn = null;
      if (!authWin.isDestroyed()) authWin.destroy();
      if (err) reject(err); else resolve(value);
    };
    cancelSignIn = () => finish(new Error('Sign-in was cancelled'));
    const check = (e, legacyUrl) => {
      const target = (e && e.url) || legacyUrl;
      if (!target || !oauth2.isCallback(target, callbackUrl)) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      finish(null, target);
    };
    authWin.webContents.on('will-redirect', check);
    authWin.webContents.on('will-navigate', check);
    authWin.webContents.on('did-start-navigation', check);
    // Providers that open a popup (for example "sign in with Google") continue in the same window.
    authWin.webContents.setWindowOpenHandler(({ url: popup }) => {
      if (/^https?:/.test(popup)) authWin.loadURL(popup);
      return { action: 'deny' };
    });
    authWin.on('closed', () => finish(new Error('The sign-in window was closed before signing in finished')));
    authWin.loadURL(url).catch((e) => { if (!done && !/ERR_ABORTED/.test(e.message)) finish(new Error(`Could not open the sign-in page: ${e.message}`)); });
  });
}

function signInWithBrowser(url, callbackUrl) {
  let cb;
  try { cb = new URL(callbackUrl); } catch { throw new Error('Enter a valid Callback URL'); }
  const host = cb.hostname.replace(/^\[|\]$/g, '');
  if (cb.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || !cb.port) {
    throw new Error('To sign in with your browser, use a callback URL on this computer with a port, such as http://127.0.0.1:8765/callback, and register it with the provider.');
  }
  const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;
  return new Promise((resolve, reject) => {
    const servers = [];
    let done = false;
    let timer;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      cancelSignIn = null;
      clearTimeout(timer);
      for (const s of servers) s.close();
      if (err) reject(err); else resolve(value);
    };
    cancelSignIn = () => finish(new Error('Sign-in was cancelled'));
    const onRequest = (req, res) => {
      const full = `http://${cb.host}${req.url}`;
      if (!oauth2.isCallback(full, callbackUrl)) { res.writeHead(404); res.end(); return; }
      const q = new URL(full).searchParams;
      if (!q.has('code') && !q.has('error') && !q.has('access_token')) {
        // Implicit grant: the token is in the fragment, which browsers don't send. Pass it on as a query.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`${page('Signing in…', 'One moment.')}<script>if (location.hash.length > 1) location.replace(location.pathname + '?' + location.hash.slice(1));</script>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(q.has('error') ? page('Sign-in failed', 'Return to HttpDash for details.') : page('Signed in', 'You can close this tab and return to HttpDash.'));
      finish(null, full);
    };
    const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
    let listening = 0;
    for (const address of addresses) {
      const server = http.createServer(onRequest);
      servers.push(server);
      server.on('error', (e) => {
        if (listening === 0 && servers.every((s) => !s.listening)) finish(new Error(`Could not listen on ${cb.host}: ${e.message}`));
      });
      server.listen(Number(cb.port), address, () => {
        listening++;
        if (listening === 1) shell.openExternal(url);
      });
    }
    timer = setTimeout(() => finish(new Error('Timed out waiting for the browser to finish signing in')), OAUTH_BROWSER_TIMEOUT_MS);
  });
}

// Gets a token with any grant. Sign-in grants return once the user has signed in.
handle('oauth2:getToken', async ({ config, scopes, settings }) => {
  const cfg = oauthConfig(config, scopes);
  const grant = cfg.grantType || 'client_credentials';
  if (!oauth2.usesBrowserRedirect(grant)) return oauthTokenRequest(cfg, grant === 'password' ? 'password' : 'client_credentials', {}, settings);
  if (cancelSignIn) cancelSignIn(); // one sign-in at a time
  const state = oauth2.randomState();
  const pkce = grant === 'authorization_code_with_pkce' ? oauth2.pkcePair(cfg.pkceMethod) : null;
  const url = oauth2.authorizationUrl(cfg, { state, pkce });
  const callback = await (cfg.useBrowser ? signInWithBrowser(url, cfg.callbackUrl) : signInWithWindow(url, cfg.callbackUrl));
  const result = oauth2.parseCallback(callback, { state, grantType: grant });
  if (result.token) return result.token;
  return oauthTokenRequest(cfg, 'code', { code: result.code, verifier: pkce && pkce.verifier }, settings);
});
handle('oauth2:refresh', async ({ config, scopes, settings }) => {
  const cfg = oauthConfig(config, scopes);
  if (!cfg.refreshToken) throw new Error('There is no refresh token. Get a new access token instead.');
  return oauthTokenRequest(cfg, 'refresh', { refreshToken: cfg.refreshToken }, settings);
});
handle('oauth2:cancel', () => { if (cancelSignIn) cancelSignIn(); });
// Signs out of every provider used in the sign-in window.
handle('oauth2:clearSessions', () => session.fromPartition(OAUTH_PARTITION).clearStorageData());

// Service discovery: query a registry and sync its services into environment values. An OpenAPI
// document also syncs a collection. Both work on copies, so a preview reports what would change
// without changing anything; `expectHash` makes applying refuse a document that changed since then.
handle('discovery:sync', async ({ config, values, collection, sourceId, settings, vars, previewOnly, expectHash }) => {
  const r = (v) => (typeof v === 'string' ? resolveVars(v, vars || {}) : v);
  const cfg = { ...config, url: r(config.url), token: r(config.token), baseUrl: r(config.baseUrl), headers: (config.headers || []).map((h) => ({ ...h, value: r(h.value) })) };
  const found = await discovery.discover(cfg, settings);
  const out = { services: found.services.map((s) => ({ ...s, variable: discovery.variableName(cfg.variablePattern, s.name) })), warnings: found.warnings };
  let generated = null;
  let extra = [];
  if (found.document) {
    generated = openapiSync.buildCollection(found.document, { variable: out.services[0].variable });
    out.spec = generated.openapi.spec;
    out.operations = openapiSync.operations(generated);
    // What each operation accepts, to warn when a request (or a version of it) no longer fits.
    out.shapes = requestShape.shapesOf(found.document);
    // The token as written in the source (it may be a {{variable}}), so the secret isn't copied around resolved.
    extra = openapiSync.secretVariables(generated, config.token);
    if (!previewOnly && expectHash && expectHash !== out.spec.hash) {
      throw new Error('The document changed again since you checked it. Check for changes again to review the new version.');
    }
  }
  const next = JSON.parse(JSON.stringify(values || []));
  out.diff = discovery.syncValues(next, found.services, { sourceId, variablePattern: cfg.variablePattern, keepMissing: !!cfg.keepMissing, extra });
  if (generated && cfg.syncRequests !== false) {
    const merged = openapiSync.mergeCollection(collection ? JSON.parse(JSON.stringify(collection)) : null, generated, { sourceId });
    out.requests = merged.diff;
    if (!previewOnly) out.collection = merged.collection;
  }
  if (!previewOnly) out.values = next;
  return out;
});

// Traffic by instance for a discovery source (counted by balancer.js as requests are sent).
handle('discovery:metrics', (sourceId) => balancer.metrics(sourceId));
handle('discovery:resetMetrics', (sourceId) => { balancer.reset(sourceId); return true; });

// ---- HttpDash API for AI agents (Settings → AI access) -------------------------------------
// The server checks the host, token, lock, pause and permission (see ai-server.js); most operations
// are answered by the window, which holds the workspace and the screen.
const { AiServer, HttpError } = require('../core/ai-server');
const aiPending = new Map(); // call id -> { resolve, reject, timer }
const callWindow = (op, args, ctx) => new Promise((resolve, reject) => {
  if (!win || win.isDestroyed()) return reject(new HttpError(503, 'The HttpDash window is closed'));
  const id = crypto.randomUUID();
  const timer = setTimeout(() => { aiPending.delete(id); reject(new HttpError(504, 'HttpDash did not answer in time')); }, 120000);
  aiPending.set(id, { resolve, reject, timer });
  win.webContents.send('ai:call', { id, op, args, ctx });
});
ipcMain.on('ai:reply', (_e, { id, ok, result, error, status }) => {
  const p = aiPending.get(id);
  if (!p) return;
  aiPending.delete(id);
  clearTimeout(p.timer);
  if (ok) p.resolve(result); else p.reject(new HttpError(status || 400, error || 'Failed'));
});
const aiServer = new AiServer({
  file: path.join(dataDir, 'ai-access.json'),
  version: app.getVersion(),
  isLocked: () => appLock.isLocked(),
  call: callWindow,
  audit,
  onActivity: (event) => { if (win && !win.isDestroyed()) win.webContents.send('ai:activity', event); },
  main: {
    getAccessLog: ({ limit }) => ({ items: aiServer.log(limit) }),
    // The whole window, a region of it, or one element (its bounds come from the window).
    // Screen points by default: half the pixels of a high-resolution capture, which is plenty for an agent.
    takeScreenshot: async ({ region, ref, scale }) => {
      if (!win || win.isDestroyed()) throw new HttpError(503, 'The HttpDash window is closed');
      const rect = (region && region !== 'window') || ref ? await callWindow('uiRect', { region, ref }) : null;
      let img = await win.webContents.capturePage(rect || undefined);
      const points = rect ? rect.width : win.getContentSize()[0];
      const want = Math.round(points * Math.min(2, Math.max(0.25, Number(scale) || 1)));
      if (want < img.getSize().width) img = img.resize({ width: want, quality: 'good' });
      const size = img.getSize();
      return { png: img.toPNG(), width: size.width, height: size.height };
    },
  },
});
handle('ai:configure', (cfg) => aiServer.configure(cfg || {}));
handle('ai:status', () => aiServer.status());
handle('ai:token', () => aiServer.token());
handle('ai:regenerate', () => { const t = aiServer.regenerateToken(); audit.append('ai.token', { action: 'regenerated' }); return t; });
handle('ai:log', (limit) => aiServer.log(limit));
app.on('before-quit', () => { aiServer.stop(); tunnels.stopAll(); });

handle('shell:openExternal', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
