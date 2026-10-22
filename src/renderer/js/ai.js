'use strict';

/*
 * The window's side of the HttpDash API for AI agents (src/core/ai-server.js, ai-api-spec.js): the
 * operations that read and change the workspace, send requests, drive the Runner and act on the
 * screen; the status bar indicator; and the AI access panel. Everything goes through the same
 * functions the app uses, so what an agent does shows up in the app as it happens.
 */
(() => {
  const { h } = HD;
  const S = HD.S;

  const DEFAULTS = { enabled: false, port: 47823, paused: false, permissions: { read: true, run: false, edit: false, ui: false, secrets: false } };
  HD.aiSettings = () => {
    const s = (S.ws.settings.ai = S.ws.settings.ai || HD.clone(DEFAULTS));
    s.permissions = { ...DEFAULTS.permissions, ...(s.permissions || {}) };
    return s;
  };
  let status = null; // from the server
  let activeUntil = 0; // the indicator pulses until then
  HD.aiConfigure = async () => {
    try { status = await window.api.ai.configure(HD.aiSettings()); } catch (e) { status = { enabled: false, error: HD.cleanErr(e) }; }
    renderIndicator();
    return status;
  };
  HD.aiStatus = () => status;

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const notFound = (what, id) => fail(404, `No ${what} with id "${id}"`);

  // ---- Secrets stay masked unless the user allowed them ----------------------------------------

  const MASK = '••••••';
  const isRef = (v) => /^\s*\{\{[^{}]+\}\}\s*$/.test(String(v == null ? '' : v));
  const SECRET_FIELDS = /^(password|token|clientSecret|accessToken|refreshToken|secretKey|sessionToken|passphrase|privateKey)$/i;
  const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
  const maskValue = (v) => (v == null || v === '' || isRef(v) ? v : MASK);
  function maskAuth(auth) {
    if (!auth || typeof auth !== 'object') return auth;
    const out = HD.clone(auth);
    const cfg = out[out.type];
    if (cfg && typeof cfg === 'object') {
      for (const k of Object.keys(cfg)) if (SECRET_FIELDS.test(k) || (out.type === 'apikey' && k === 'value')) cfg[k] = maskValue(cfg[k]);
    }
    return out;
  }
  const maskRows = (rows) => (rows || []).map((r) => (r && r.secret ? { ...r, value: maskValue(r.value) } : r));
  const maskHeaders = (rows) => (rows || []).map((r) => (r && SECRET_HEADERS.test(r.key || '') ? { ...r, value: maskValue(r.value) } : r));
  const maskRequest = (def, ctx) => (ctx.permissions.secrets ? HD.clone(def) : { ...HD.clone(def), auth: maskAuth(def.auth), headers: maskHeaders(def.headers) });
  // A masked value sent back unchanged keeps the real one.
  function keepMasked(next, prev) {
    if (next === MASK) return prev;
    if (next && typeof next === 'object' && prev && typeof prev === 'object' && !Array.isArray(next)) {
      const out = { ...next };
      for (const k of Object.keys(out)) out[k] = keepMasked(out[k], prev[k]);
      return out;
    }
    if (Array.isArray(next) && Array.isArray(prev)) {
      return next.map((r) => (r && r.value === MASK ? { ...r, value: (prev.find((p) => p && p.key === r.key) || {}).value } : r));
    }
    return next;
  }

  // ---- Workspace lookups -------------------------------------------------------------------------

  const summary = (it, parents = []) => ({
    id: it.id, name: it.name, method: it.request.method, url: it.request.url, tags: it.request.tags || [],
    ...(parents.length ? { path: parents.map((p) => p.name).join(' / ') } : {}),
  });
  const tree = (node) => (node.type === 'request' ? { type: 'request', ...summary(node) }
    : { type: node.type, id: node.id, name: node.name, items: (node.items || []).map(tree) });
  const findRequest = (id) => {
    const f = HD.find(id);
    if (!f || f.node.type !== 'request') throw notFound('request', id);
    return f;
  };
  const findCollection = (id) => {
    const c = S.ws.collections.find((x) => x.id === id);
    if (!c) throw notFound('collection', id);
    return c;
  };
  const findFolder = (id) => {
    const f = HD.find(id);
    if (!f || f.node.type !== 'folder') throw notFound('folder', id);
    return f;
  };
  // Name, description and scripts of a collection or folder an agent may set.
  const CONTAINER_FIELDS = ['name', 'description', 'preRequestScript', 'testScript'];
  function applyContainerFields(node, given) {
    for (const k of CONTAINER_FIELDS) {
      if (given[k] == null || (k === 'name' && !given[k])) continue;
      node[k] = String(given[k]);
    }
    const cur = HD.currentTab();
    if (cur && cur.refId === node.id) HD.renderActiveTab();
    HD.renderTabBar();
    return node;
  }
  const findEnvironment = (id) => {
    const e = S.ws.environments.find((x) => x.id === id);
    if (!e) throw notFound('environment', id);
    return e;
  };
  const changed = () => { HD.save(); HD.renderSidebar(); };
  // Open tabs of a request take its new definition, unless they have unsaved edits of their own.
  const refreshTabs = (id) => {
    const busy = [];
    for (const t of S.ws.tabs.filter((x) => x.kind === 'request' && x.refId === id)) {
      if (t.dirty) { busy.push(t.id); continue; }
      const f = HD.find(id);
      t.draft = { name: f.node.name, request: HD.clone(f.node.request) };
    }
    const cur = HD.currentTab();
    if (cur && cur.refId === id) HD.renderActiveTab();
    HD.renderTabBar();
    return busy;
  };

  // Fields of a request definition an agent may set.
  const REQUEST_FIELDS = ['method', 'url', 'params', 'headers', 'body', 'auth', 'description', 'tags', 'preRequestScript', 'testScript', 'payloads', 'pathVariables', 'settings'];
  function applyRequestFields(req, given) {
    for (const k of REQUEST_FIELDS) {
      if (!(k in (given || {}))) continue;
      let v = HD.clone(given[k]);
      if (k === 'auth' || k === 'headers') v = keepMasked(v, req[k]);
      if (k === 'method') v = String(v || 'GET').toUpperCase();
      if (k === 'tags') v = HD.normalizeTags(v);
      if (k === 'body') v = { ...HD.newRequestDef().body, ...(v || {}) };
      if ((k === 'params' || k === 'headers') && Array.isArray(v)) v = v.map((r) => ({ key: String(r.key || ''), value: r.value == null ? '' : String(r.value), enabled: r.enabled !== false, ...(r.description ? { description: String(r.description) } : {}) }));
      req[k] = v;
    }
    // URL and query params stay in step, as in the editor.
    if ('url' in (given || {}) && !('params' in given)) HD.syncParamsFromUrl(req);
    else if ('params' in (given || {}) && !('url' in given)) req.url = HD.urlFromParams(req);
    else if ('url' in (given || {})) HD.syncParamsFromUrl(req);
    return req;
  }

  // ---- Sending -----------------------------------------------------------------------------------

  // "GET /orders/{id}"-style default name: the method and the path, without the base URL variable.
  const defaultName = (req) => {
    const path = String(req.url || '').replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] || '/';
    return `${req.method} ${path}`;
  };

  /**
   * A collection (by id or name) and the folders of a path in it ("Orders/Admin"). With create,
   * missing ones are made; without, the deepest existing folder is used (to inherit from).
   * Returns { collection, parents, folder } or null when the collection doesn't exist.
   */
  function placeFor(collectionRef, folderPath, { create }) {
    const ref = String(collectionRef || '').trim();
    let c = S.ws.collections.find((x) => x.id === ref) || S.ws.collections.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!c) {
      if (!create) return null;
      c = HD.newCollection(ref);
      S.ws.collections.push(c);
    }
    const parents = [];
    let items = c.items;
    for (const name of String(folderPath || '').split('/').map((x) => x.trim()).filter(Boolean)) {
      let folder = items.find((x) => x.type === 'folder' && x.name.toLowerCase() === name.toLowerCase());
      if (!folder) {
        if (!create) break;
        folder = HD.newFolder(name);
        items.push(folder);
      }
      parents.push(folder);
      items = folder.items;
    }
    return { collection: c, parents, folder: parents[parents.length - 1] || null };
  }

  /**
   * Keeps a request an agent sent: in its collection and folder (made when missing), updating the
   * one with the same method and URL there, with the response as an example and the tag "ai".
   */
  function keep(req, result, body, name) {
    const res = result.response;
    const failedTests = (result.tests || []).some((t) => !t.passed && !t.skipped);
    const ok = !!res && res.status < 400 && !result.error && !failedTests;
    if ((body.saveIf || 'success') !== 'always' && !ok) {
      const why = result.error ? 'The request failed' : `It answered ${res ? res.status : 'nothing'}${failedTests ? ' with failed tests' : ''}`;
      return { kept: false, reason: `${why}, so it was not saved (saveIf: "always", or --save-always, keeps it anyway)` };
    }
    const place = placeFor(body.collection || 'AI requests', body.folder, { create: true });
    const items = place.folder ? place.folder.items : place.collection.items;
    const same = items.find((x) => x.type === 'request' && String(x.request.method).toUpperCase() === req.method && x.request.url === req.url);
    const item = same || HD.newRequestItem(name);
    const tags = HD.normalizeTags([...(item.request.tags || []), ...(body.tags || []), 'ai']);
    if (same) {
      applyRequestFields(item.request, { ...body.request, tags });
      if (body.name) item.name = String(body.name);
    } else {
      Object.assign(item.request, HD.clone(req));
      item.request.tags = tags;
      items.push(item);
    }
    if (res) {
      // The answer it got, as an example (one per status: the newest replaces the last).
      const label = `${res.status} ${res.statusText || ''}`.trim();
      item.examples = (item.examples || []).filter((e) => e.name !== label);
      item.examples.push({ id: HD.uid(), name: label, status: res.status, statusText: res.statusText, headers: res.headers, body: String(res.bodyText || '').slice(0, 256 * 1024), request: HD.clone(item.request) });
    }
    changed();
    refreshTabs(item.id);
    return {
      kept: true, requestId: item.id, collectionId: place.collection.id, ...(place.folder ? { folderId: place.folder.id } : {}),
      path: [place.collection, ...place.parents].map((p) => p.name).join(' / '), name: item.name, [same ? 'updated' : 'created']: true,
    };
  }

  const chainOf = (f) => (f ? [f.collection, ...f.parents] : []).map((n) => ({ id: n.id, name: n.name, auth: n.auth, preRequestScript: n.preRequestScript, testScript: n.testScript, dependency: n.dependency, health: n.health }));
  function scopesWith(collection, environmentId) {
    if (!environmentId) return HD.scopesFor(collection);
    const env = findEnvironment(environmentId);
    return { globals: HD.listToObject(S.ws.globals), collection: collection ? HD.listToObject(collection.variables) : {}, environment: HD.listToObject(env.values), data: {}, pools: HD.discoveryPools(env) };
  }
  const settingsFor = (req) => {
    const g = S.ws.settings;
    const o = req.settings || {};
    const pick = (k) => (o[k] === undefined || o[k] === null ? g[k] : o[k]);
    return { ...g, followRedirects: pick('followRedirects'), verifySSL: pick('verifySSL'), sendCookies: pick('sendCookies'), timeout: o.timeout == null ? g.timeout : o.timeout, tunnelId: HD.tunnelIdFor(HD.activeEnvironment()) };
  };
  function shape(result, maxBody = 100000) {
    const r = result.response;
    const tests = result.tests || [];
    const body = r ? String(r.bodyText || '') : '';
    return {
      response: r ? {
        status: r.status, statusText: r.statusText, time: r.time, size: r.size, contentType: r.contentType,
        headers: r.headers, body: body.slice(0, maxBody), ...(body.length > maxBody ? { bodyTruncated: true, bodyLength: body.length } : {}),
        ...(r.timings ? { timings: r.timings } : {}),
      } : null,
      error: result.error || null,
      tests: tests.map((t) => ({ name: t.name, passed: !!t.passed, skipped: !!t.skipped, ...(t.error ? { error: t.error } : {}) })),
      testsSummary: { passed: tests.filter((t) => t.passed && !t.skipped).length, failed: tests.filter((t) => !t.passed).length, skipped: tests.filter((t) => t.skipped).length },
      ...(result.sentRequest ? { sent: { method: result.sentRequest.method, url: result.sentRequest.url } } : {}),
      ...(result.routing ? { instances: result.routing.map((x) => ({ variable: x.variable, instance: x.instanceId || x.instance, servedBy: x.servedBy || undefined })) } : {}),
      ...(result.payload ? { payload: result.payload.name } : {}),
      ...(result.network ? { network: result.network } : {}),
      ...(result.health ? { health: {
        url: result.health.url, healthy: result.health.ok, unhealthyReadings: result.health.unhealthy, readings: result.health.samples.length, slowestMs: result.health.slowest,
        summary: HD.healthLine(result.health, 5),
        changed: result.health.fields.filter((f) => f.changed).slice(0, 50).map((f) => ({ field: f.path, before: f.before, after: f.after, ...(f.numeric ? { min: f.min, max: f.max } : {}) })),
      } } : {}),
    };
  }
  async function send({ request, f, environmentId, payloadIndex, name }) {
    const collection = f ? f.collection : null;
    const scopes = scopesWith(collection, environmentId);
    const result = await window.api.send({
      id: `ai-${HD.uid()}`, request: HD.clone(request), chain: chainOf(f), collection: collection ? HD.clone(collection) : null, scopes,
      settings: settingsFor(request), info: { requestName: name, requestId: f ? f.node.id : undefined, payloadIndex },
    });
    if (result.scopes) HD.applyScopes(scopes, result.scopes, collection);
    result.history = HD.addHistory({
      name: `${name} (AI)`, method: request.method, url: result.sentRequest ? result.sentRequest.url : request.url, status: result.response ? result.response.status : null,
      time: Date.now(), duration: result.response ? result.response.time : null, request: HD.clone(request), collectionId: collection ? collection.id : null, requestId: f && f.node.id ? f.node.id : null, error: result.error || null,
    });
    return result;
  }
  const show = (id, result, resTab) => {
    HD.openRequest(id);
    const tab = HD.currentTab();
    if (!tab) return;
    S.responses.set(tab.id, result);
    if (resTab) tab.ui = { ...(tab.ui || {}), resTab };
    HD.renderActiveTab();
  };

  // ---- The Runner --------------------------------------------------------------------------------

  const runnerTab = () => S.ws.tabs.find((t) => t.kind === 'runner');
  function runState(tabId) {
    const run = HD.runnerRun(tabId);
    if (!run || (!run.running && !run.summary && !run.error && !run.results.length)) return null;
    return run.running ? 'running' : run.error ? 'error' : run.summary && run.summary.stopped ? 'stopped' : 'finished';
  }

  // ---- The screen --------------------------------------------------------------------------------

  const REGIONS = { sidebar: '#sidebar-wrap', main: '#workspace', request: '.req-section', response: '.res-pane', modal: '.modal', topbar: '#topbar', statusbar: '#statusbar' };
  let refs = new Map(); // ref -> element, from the last snapshot
  let nextRef = 1;
  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const regionOf = (el) => {
    if (el.closest('.modal')) return 'modal';
    if (el.closest('.search-menu, .ctx-menu')) return 'menu';
    if (el.closest('#sidebar-wrap')) return 'sidebar';
    if (el.closest('.res-pane')) return 'response';
    if (el.closest('.req-section')) return 'request';
    if (el.closest('#tabbar')) return 'tabs';
    if (el.closest('#topbar')) return 'topbar';
    if (el.closest('#statusbar')) return 'statusbar';
    return 'main';
  };
  // A form control's visible label: its field's caption, a checkbox's text, a setting's name.
  const fieldLabel = (el) => {
    const f = el.closest('label.field, label.check, .setting-row');
    if (!f) return '';
    const caption = f.matches('label.field') ? f.querySelector(':scope > span') : f.matches('.setting-row') ? f.querySelector('.setting-label') : null;
    return ((caption ? caption.textContent : f.innerText) || '').replace(/\s+/g, ' ').trim();
  };
  const label = (el) => {
    const t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (el.matches('input, select, textarea')) {
      const named = el.getAttribute('aria-label') || fieldLabel(el);
      const ph = el.getAttribute('placeholder') || '';
      if (named || ph) return (named && ph && named !== ph ? `${named} (${ph})` : named || ph).slice(0, 120);
    }
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const ph = el.getAttribute('placeholder') || '';
    const kind = el.classList && el.classList.length ? String(el.classList[0]).replace(/-/g, ' ') : el.tagName.toLowerCase();
    return (text || t || ph || `(${kind})`).slice(0, 120);
  };
  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'input') return ['checkbox', 'radio'].includes(el.type) ? el.type : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a') return 'link';
    if (tag === 'summary') return 'disclosure';
    if (el.classList.contains('subtab')) return 'tab';
    if (el.classList.contains('tree-row')) return el.classList.contains('container') ? 'treeitem (folder)' : 'treeitem';
    if (el.classList.contains('jt-toggle')) return 'expander';
    if (el.classList.contains('CodeMirror')) return 'editor';
    return tag === 'button' ? 'button' : 'clickable';
  }
  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role=tab], [role=option], [role=treeitem], .tree-row, .subtab, .jt-toggle, .CodeMirror';
  function snapshot({ region = 'all', text = true } = {}) {
    refs = new Map();
    const root = region && region !== 'all' ? document.querySelector(REGIONS[region] || '') : document.body;
    if (!root) throw fail(404, `Nothing is showing in the "${region}" region`);
    const seen = new Set();
    const els = [...root.querySelectorAll(INTERACTIVE), ...[...root.querySelectorAll('*')].filter((e) => e.__hdClickable)];
    const elements = [];
    for (const el of els) {
      if (seen.has(el) || !visible(el)) continue;
      // A CodeMirror's own textarea and a clickable's inner button are reported once.
      if (el.closest('.CodeMirror') && !el.classList.contains('CodeMirror')) continue;
      seen.add(el);
      const ref = `e${nextRef++}`;
      refs.set(ref, el);
      const r = el.getBoundingClientRect();
      const item = { ref, role: roleOf(el), label: label(el), region: regionOf(el), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
      if (el.matches('input, textarea, select')) item.value = el.type === 'password' ? (el.value ? MASK : '') : String(el.value).slice(0, 200);
      if (el.classList.contains('CodeMirror') && el.CodeMirror) item.value = el.CodeMirror.getValue().slice(0, 500);
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
      if (el.disabled) item.disabled = true;
      if (el.classList.contains('active') || el.getAttribute('aria-selected') === 'true') item.active = true;
      const exp = el.getAttribute('aria-expanded') || (el.closest('details') && el.tagName === 'SUMMARY' ? String(el.closest('details').open) : null);
      if (exp != null) item.expanded = exp === 'true';
      if (el.classList.contains('tree-row') && el.dataset.id) item.id = el.dataset.id;
      elements.push(item);
      if (elements.length >= 600) break;
    }
    // Scrollable areas, so an agent can scroll lists and panes.
    const scrollables = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.scrollHeight - el.clientHeight < 8 || !visible(el)) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const ref = `e${nextRef++}`;
      refs.set(ref, el);
      scrollables.push({ ref, role: 'scrollable', region: regionOf(el), label: (el.className && String(el.className).split(' ')[0]) || el.id || el.tagName.toLowerCase(),
        scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
    const out = { region, viewport: { width: window.innerWidth, height: window.innerHeight }, elements, scrollables };
    if (text) out.text = visibleText(root).slice(0, 12000);
    return out;
  }
  // The text a person would read, line by line, skipping what's off screen.
  function visibleText(root) {
    const lines = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t || !n.parentElement || !visible(n.parentElement) || n.parentElement.closest('script, style')) continue;
      const block = n.parentElement.closest('div, li, tr, p, h1, h2, h3, pre, label, td, th, summary') || n.parentElement;
      if (block === last) lines[lines.length - 1] += ` ${t}`; else lines.push(t);
      last = block;
    }
    return lines.join('\n');
  }
  // Shows the user what the agent is acting on.
  function flash(el) {
    const r = el.getBoundingClientRect();
    const mark = h('div.ai-flash', { style: { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` } });
    document.body.appendChild(mark);
    setTimeout(() => mark.remove(), 900);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const describe = () => {
    const t = HD.currentTab();
    const modal = document.querySelector('.modal .modal-title');
    return { activeTab: t ? { id: t.id, kind: t.kind, title: tabTitle(t) } : null, dialog: modal ? modal.textContent : null };
  };
  // A cheap picture of the screen, to tell whether an action changed anything (an expanded folder,
  // a new view, a menu).
  const screenPrint = () => `${S.ws.activeTabId}|${document.querySelectorAll('.tree-row, .search-option, .ctx-menu, .modal, details[open]').length}|${(document.querySelector('#content') || document.body).innerText.length}`;
  const tabTitle = (t) => (t.kind === 'request' ? (t.draft && t.draft.name) : (HD.tabTitle ? HD.tabTitle(t) : t.kind));
  async function act({ ref, action, text, key, value, by, to }) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) throw fail(409, `Ref "${ref}" is not on screen any more; take a new snapshot`);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    flash(el);
    const cm = el.classList.contains('CodeMirror') ? el.CodeMirror : null;
    const before = screenPrint();
    if (action === 'click' || action === 'doubleClick') {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      if (action === 'doubleClick') el.dispatchEvent(new MouseEvent('dblclick', opts));
    } else if (action === 'focus') (cm || el).focus();
    else if (action === 'type') {
      if (cm) cm.setValue(String(text || ''));
      else if (el.matches('input, textarea')) {
        el.focus();
        el.value = String(text || '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else throw fail(400, 'Only text fields and editors can be typed into');
    } else if (action === 'press') {
      const target = cm ? cm.getInputField() : el;
      target.focus();
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key: String(key || ''), bubbles: true, cancelable: true }));
    } else if (action === 'select') {
      if (!el.matches('select')) throw fail(400, 'Only drop-downs can be chosen from');
      const opt = [...el.options].find((o) => o.value === value || o.textContent.trim() === value);
      if (!opt) throw fail(400, `No option "${value}"; the options are: ${[...el.options].map((o) => o.textContent.trim()).join(', ')}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action === 'check' || action === 'uncheck') {
      if (el.type !== 'checkbox' && el.type !== 'radio') throw fail(400, 'Only checkboxes can be checked');
      if (el.checked !== (action === 'check')) el.click();
    } else if (action === 'scroll') {
      const box = el.scrollHeight > el.clientHeight + 4 ? el : el.closest('*') && [...ancestors(el)].find((a) => a.scrollHeight > a.clientHeight + 4);
      if (to && refs.get(to)) refs.get(to).scrollIntoView({ block: 'center' });
      else if (box && to === 'top') box.scrollTop = 0;
      else if (box && to === 'bottom') box.scrollTop = box.scrollHeight;
      else if (box) box.scrollTop += Number(by) || box.clientHeight * 0.8;
      else throw fail(400, 'Nothing to scroll there');
    } else throw fail(400, `Unknown action "${action}"`);
    await wait(250);
    const after = describe();
    return { ok: true, ...after, changed: screenPrint() !== before, hint: 'Refs may have changed; take a new snapshot before the next action.' };
  }
  function* ancestors(el) { for (let a = el.parentElement; a; a = a.parentElement) yield a; }

  // ---- The operations ----------------------------------------------------------------------------

  const ops = {
    getStatus: (args, ctx) => {
      const env = HD.activeEnvironment();
      const rt = runnerTab();
      let requests = 0;
      for (const c of S.ws.collections) HD.walk(c.items, (it) => { if (it.type === 'request') requests++; });
      return {
        app: 'HttpDash', permissions: ctx.permissions,
        activeEnvironment: env ? { id: env.id, name: env.name } : null,
        counts: { collections: S.ws.collections.length, requests, environments: S.ws.environments.length, discoverySources: HD.discoverySources().length },
        tabs: S.ws.tabs.map((t) => ({ id: t.id, kind: t.kind, title: tabTitle(t), active: t.id === S.ws.activeTabId, ...(t.refId ? { itemId: t.refId } : {}) })),
        run: rt && runState(rt.id) ? { runId: rt.id, state: runState(rt.id) } : null,
      };
    },

    listCollections: () => ({ collections: S.ws.collections.map(tree) }),
    getCollection: ({ collectionId }, ctx) => {
      const c = findCollection(collectionId);
      return {
        ...tree(c), description: c.description || '', auth: ctx.permissions.secrets ? c.auth : maskAuth(c.auth),
        variables: ctx.permissions.secrets ? c.variables : maskRows(c.variables), preRequestScript: c.preRequestScript || '', testScript: c.testScript || '',
      };
    },
    searchRequests: ({ text, tag, method, url, limit }) => {
      const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      const query = { tokens: [...split(tag).map((value) => ({ kind: 'tag', value })), ...split(method).map((value) => ({ kind: 'method', value: value.toUpperCase() })), ...(url ? [{ kind: 'url', value: url }] : [])], text: text || '' };
      const items = [];
      for (const c of S.ws.collections) {
        const vars = HD.searchVars(c);
        HD.walk(c.items, (it, parents) => { if (it.type === 'request' && HD.matchRequest(it, query, { path: [c, ...parents].map((p) => p.name), vars })) items.push({ ...summary(it, [c, ...parents]), collectionId: c.id }); });
      }
      return { items: items.slice(0, Math.min(Number(limit) || 100, 1000)), total: items.length };
    },
    getRequest: ({ requestId }, ctx) => {
      const f = findRequest(requestId);
      return {
        id: f.node.id, name: f.node.name, collectionId: f.collection.id, path: [f.collection, ...f.parents].map((p) => p.name).join(' / '),
        request: maskRequest(f.node.request, ctx), examples: (f.node.examples || []).map((e) => ({ name: e.name, status: e.status })),
      };
    },
    createCollection: ({ body }) => {
      const c = applyContainerFields(HD.newCollection(String(body.name)), body);
      c.variables = Object.entries(body.variables || {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
      S.ws.collections.push(c);
      changed();
      return { id: c.id, name: c.name };
    },
    createFolder: ({ collectionId, body }) => {
      const c = findCollection(collectionId);
      const parent = body.parentFolderId ? HD.find(body.parentFolderId) : null;
      if (body.parentFolderId && (!parent || parent.node.type !== 'folder' || parent.collection.id !== c.id)) throw notFound('folder in this collection', body.parentFolderId);
      const folder = applyContainerFields(HD.newFolder(String(body.name)), body);
      (parent ? parent.node.items : c.items).push(folder);
      changed();
      return { id: folder.id, name: folder.name };
    },
    updateCollection: ({ collectionId, body }) => {
      const c = applyContainerFields(findCollection(collectionId), body);
      changed();
      return { id: c.id, name: c.name };
    },
    getFolder: ({ folderId }, ctx) => {
      const f = findFolder(folderId);
      return {
        ...tree(f.node), collectionId: f.collection.id, path: [f.collection, ...f.parents].map((p) => p.name).join(' / '), description: f.node.description || '',
        auth: ctx.permissions.secrets ? f.node.auth : maskAuth(f.node.auth), preRequestScript: f.node.preRequestScript || '', testScript: f.node.testScript || '',
      };
    },
    updateFolder: ({ folderId, body }) => {
      const f = findFolder(folderId);
      applyContainerFields(f.node, body);
      changed();
      return { id: f.node.id, name: f.node.name };
    },
    createRequest: ({ body }) => {
      const c = findCollection(body.collectionId);
      const parent = body.folderId ? HD.find(body.folderId) : null;
      if (body.folderId && (!parent || parent.node.type !== 'folder' || parent.collection.id !== c.id)) throw notFound('folder in this collection', body.folderId);
      const item = HD.newRequestItem(String(body.name));
      applyRequestFields(item.request, body.request || {});
      (parent ? parent.node.items : c.items).push(item);
      changed();
      return { id: item.id, ...summary(item) };
    },
    updateRequest: ({ requestId, body }) => {
      const f = findRequest(requestId);
      if (body.name) f.node.name = String(body.name);
      if (body.request) applyRequestFields(f.node.request, body.request);
      changed();
      const unsaved = refreshTabs(requestId);
      return { id: f.node.id, ...summary(f.node), ...(unsaved.length ? { note: 'It is open in a tab with unsaved edits, which still show the old version.' } : {}) };
    },
    deleteRequest: ({ requestId }) => {
      const f = findRequest(requestId);
      const list = f.parents.length ? f.parents[f.parents.length - 1].items : f.collection.items;
      list.splice(list.indexOf(f.node), 1);
      S.ws.tabs.filter((t) => t.refId === requestId).forEach((t) => HD.closeTab(t.id, true));
      changed();
      return { deleted: requestId };
    },

    listEnvironments: () => ({
      items: S.ws.environments.map((e) => ({ id: e.id, name: e.name, active: e.id === S.ws.activeEnvironmentId, ...(e.color ? { color: e.color } : {}), variables: e.values.filter((v) => v.key).length, ...(e.discoverySourceId ? { fromDiscovery: true } : {}) })),
    }),
    getEnvironment: ({ environmentId }, ctx) => {
      const e = findEnvironment(environmentId);
      return { id: e.id, name: e.name, active: e.id === S.ws.activeEnvironmentId, values: (ctx.permissions.secrets ? e.values : maskRows(e.values)).filter((v) => v.key) };
    },
    setEnvironmentVariables: ({ environmentId, body }) => {
      const e = findEnvironment(environmentId);
      for (const [key, value] of Object.entries(body.set || {})) {
        const row = e.values.find((v) => v.key === key);
        if (row) { if (value !== MASK) row.value = String(value); } else e.values.push({ key, value: String(value), enabled: true });
      }
      for (const key of body.unset || []) e.values = e.values.filter((v) => v.key !== key);
      changed();
      HD.refreshVarHighlights();
      if (S.ws.tabs.some((t) => t.kind === 'environment' && t.refId === e.id && t.id === S.ws.activeTabId)) HD.renderActiveTab();
      return { id: e.id, variables: e.values.filter((v) => v.key).length };
    },
    activateEnvironment: ({ environmentId }) => {
      const id = environmentId === 'none' ? null : findEnvironment(environmentId).id;
      S.ws.activeEnvironmentId = id;
      HD.save();
      HD.renderEnvSelect();
      HD.renderSidebar();
      HD.refreshVarHighlights();
      return { activeEnvironment: id };
    },

    sendRequest: async ({ requestId, body }) => {
      const f = findRequest(requestId);
      const result = await send({ request: f.node.request, f, environmentId: body.environmentId, payloadIndex: body.payloadIndex, name: f.node.name });
      if (body.show) show(requestId, result, 'body');
      return shape(result, body.maxBodyBytes);
    },
    sendAdHoc: async ({ body }, ctx) => {
      if (body.save && !(ctx && ctx.permissions && ctx.permissions.edit)) throw fail(403, 'Saving needs the "edit" permission, which is off in HttpDash (Settings → AI access); send without save, or ask for it to be turned on');
      // Inside a collection (and folder), the request inherits their auth and auth dependency.
      const place = body.collection ? placeFor(body.collection, body.folder, { create: false }) : null;
      if (body.collection && !place && !body.save) throw notFound('collection', body.collection);
      const req = applyRequestFields(HD.newRequestDef({ auth: { type: place ? 'inherit' : 'none' } }), body.request || {});
      if (!req.url) throw fail(400, 'The request needs a url');
      const f = place ? { collection: place.collection, parents: place.parents, node: { id: undefined, request: req } } : null;
      const name = body.name ? String(body.name) : defaultName(req);
      const result = await send({ request: req, f, environmentId: body.environmentId, name });
      const out = shape(result, body.maxBodyBytes);
      if (body.save) {
        out.saved = keep(req, result, body, name);
        // Its history entry now opens the saved request.
        if (out.saved.kept && result.history) { result.history.requestId = out.saved.requestId; HD.save(); HD.emit('history'); }
      }
      return out;
    },
    compareInstances: async ({ requestId, body }) => {
      const f = findRequest(requestId);
      const req = f.node.request;
      const env = HD.activeEnvironment();
      // A discovered service in the URL (synced again first), or else several addresses in DNS.
      let target = null;
      const pick = () => Object.entries(HD.discoveryPools(env) || {}).find(([v, pool]) => new RegExp(`\\{\\{\\s*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`).test(req.url)
        && (pool.instances || []).filter((i) => i.url && i.healthy !== false).length >= 2);
      let found = pick();
      if (found) {
        const src = HD.discoverySources().find((s) => s.id === found[1].sourceId);
        if (src) await HD.syncDiscovery(src, { silent: true });
        found = pick();
      }
      if (found) target = { variable: found[0] };
      else {
        const dns = await window.api.dnsInstances({ request: { url: req.url }, scopes: HD.scopesFor(f.collection), settings: settingsFor(req) });
        if (dns) target = { dns: true };
      }
      if (!target) throw fail(409, 'The URL uses no discovered service with two or more healthy instances, and its host has one address in DNS: nothing to compare');
      const out = await window.api.compareInstances({
        id: `ai-${HD.uid()}`, request: HD.clone(req), chain: chainOf(f), collection: HD.clone(f.collection), scopes: HD.scopesFor(f.collection), settings: settingsFor(req),
        info: { requestName: f.node.name, requestId }, variable: target.variable, dns: !!target.dns,
      });
      if (body.show) show(requestId, { ...out.results[out.comparison.baseline], compare: { variable: out.variable, dns: out.dns, service: out.service, comparison: out.comparison, results: out.results, shown: out.comparison.baseline } }, 'compare');
      const c = out.comparison;
      return {
        service: out.service, by: out.dns ? 'dns' : 'discovery',
        instances: c.instances.map((i, idx) => {
          const net = out.results[idx] && out.results[idx].network && out.results[idx].network.connected;
          return { instance: i.instanceId || i.instance, ...(net ? { address: net.address, segment: net.segment } : {}), status: i.status, time: i.time, error: i.error || undefined, tests: i.tests, differsIn: i.odd };
        }),
        differences: c.differences.map((d) => ({ field: d.key, kind: d.kind, mostInstances: d.majority || undefined, values: d.values.map((v) => ({ instance: v.instanceId || v.instance, value: v.value.slice(0, 300) })) })),
      };
    },
    getHistory: ({ limit }) => ({
      items: (S.ws.history || []).slice(0, Math.min(Number(limit) || 50, 500)).map((e) => ({ time: e.time, name: e.name, method: e.method, url: e.url, status: e.status, duration: e.duration, ...(e.error ? { error: e.error } : {}) })),
    }),

    startRun: async ({ body }) => {
      const c = findCollection(body.collectionId);
      const existing = runnerTab();
      if (existing && runState(existing.id) === 'running') throw fail(409, 'A run is already in progress; stop it or wait for it (getRun)');
      if (body.folderId) { const fo = HD.find(body.folderId); if (!fo || fo.node.type !== 'folder' || fo.collection.id !== c.id) throw notFound('folder in this collection', body.folderId); }
      if (body.environmentId) findEnvironment(body.environmentId);
      HD.openRunner(c.id, body.folderId || null);
      const tab = runnerTab();
      const scope = body.folderId ? HD.find(body.folderId).node.items : c.items;
      const all = [];
      HD.walk(scope, (it) => { if (it.type === 'request') all.push(it); });
      const ids = body.requestIds && body.requestIds.length ? new Set(body.requestIds) : null;
      const query = { tokens: (body.tags || []).map((value) => ({ kind: 'tag', value })), text: '' };
      const included = all.filter((it) => (!ids || ids.has(it.id)) && HD.matchRequest(it, query));
      if (!included.length) throw fail(400, 'No request in that collection or folder matches; nothing to run');
      let data = {};
      if (body.data != null) {
        if (!Array.isArray(body.data) || body.data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw fail(400, 'data must be an array of objects, one per iteration');
        if (body.data.length > 10000) throw fail(400, 'data has more than 10000 rows');
        data = body.data.length ? { dataFile: 'Data from AI agent', data: HD.clone(body.data) } : { dataFile: null, data: null };
      }
      const rows = (data.data !== undefined ? data.data : tab.runner.data) || [];
      tab.runner = {
        ...tab.runner, ...data, collectionId: c.id, folderId: body.folderId || null,
        environmentId: body.environmentId || S.ws.activeEnvironmentId, iterations: Math.max(1, Number(body.iterations) || rows.length || 1),
        delay: Math.max(0, Number(body.delayMs) || 0), stopOnFailure: !!body.stopOnFailure,
        excluded: Object.fromEntries(all.filter((it) => !included.includes(it)).map((it) => [it.id, true])),
      };
      HD.save();
      HD.renderActiveTab();
      Promise.resolve().then(() => HD.startRunnerTab(tab.id)).catch(() => {});
      await wait(50);
      return {
        runId: tab.id, state: 'running', requests: included.length, iterations: tab.runner.iterations,
        ...(rows.length ? { dataFile: tab.runner.dataFile, dataRows: rows.length } : {}),
      };
    },
    getRun: ({ runId, results = 'failed' }) => {
      const run = HD.runnerRun(runId);
      const state = runState(runId);
      if (!run || !state) throw notFound('run', runId);
      const list = run.results || [];
      const failedOf = (r) => r.error || (r.tests || []).some((t) => !t.passed);
      const pick = results === 'all' ? list : results === 'none' ? [] : list.filter(failedOf);
      const tests = list.flatMap((r) => r.tests || []);
      return {
        runId, state, ...(run.error ? { error: run.error } : {}),
        progress: { done: list.length, iteration: (run.iteration || 0) + 1, current: run.running ? run.current || null : null },
        totals: { requests: list.length, failedRequests: list.filter((r) => r.error).length, tests: tests.length, passed: tests.filter((t) => t.passed && !t.skipped).length, failed: tests.filter((t) => !t.passed).length },
        ...(run.summary ? { durationMs: run.summary.duration } : {}),
        ...(run.summary && run.summary.instances ? { byInstance: run.summary.instances.map((x) => ({ service: x.service, instance: x.instanceId || x.instance, requests: x.requests, p50: x.p50, p95: x.p95, errors: x.errors })) } : {}),
        results: pick.slice(0, 500).map((r) => ({
          iteration: r.iteration + 1, name: r.name, method: r.method, url: r.url, status: r.status, time: r.time, ...(r.error ? { error: r.error } : {}),
          tests: (r.tests || []).map((t) => ({ name: t.name, passed: !!t.passed, ...(t.error ? { error: t.error } : {}) })), ...(r.payload ? { payload: r.payload.name } : {}),
        })),
      };
    },
    stopRun: async ({ runId }) => {
      if (runState(runId) !== 'running') throw fail(409, 'That run is not in progress');
      await window.api.stopRun();
      return { runId, state: 'stopping' };
    },

    listDiscoverySources: () => ({
      items: HD.discoverySources().map((s) => ({
        id: s.id, name: s.name, provider: s.provider, environmentId: s.environmentId, balance: s.balance || 'first', ...(s.instanceHeader ? { instanceHeader: s.instanceHeader } : {}),
        ...(s.collectionId ? { collectionId: s.collectionId } : {}),
        lastSync: s.lastSync ? { time: s.lastSync.time, error: s.lastSync.error || undefined, services: (s.lastSync.services || []).map((x) => ({ name: x.name, variable: x.variable, url: x.url, instances: (x.instances || []).map((i) => ({ id: i.id, url: i.url, healthy: i.healthy !== false })) })) } : null,
      })),
    }),
    syncDiscoverySource: async ({ sourceId, body }) => {
      const src = HD.discoverySources().find((s) => s.id === sourceId);
      if (!src) throw notFound('discovery source', sourceId);
      if (src.provider === 'openapi' && src.collectionId && !body.apply) {
        const res = await HD.checkDiscovery(src);
        const rq = res.requests;
        return { checkedOnly: true, spec: res.spec, previous: rq && rq.spec.previous, changes: rq ? rq.changes : [], hint: 'Call again with apply: true to apply these changes.' };
      }
      const res = await HD.syncDiscovery(src, { expectHash: null });
      if (!res) throw fail(502, src.lastSync && src.lastSync.error ? src.lastSync.error : 'The sync failed');
      return { services: res.services.map((s) => ({ name: s.name, variable: s.variable, url: s.url, instances: (s.instances || []).length })), variables: res.diff, ...(res.requests ? { requests: { added: res.requests.added, changed: res.requests.updated, removed: res.requests.removed } } : {}) };
    },
    getTraffic: async ({ sourceId }) => {
      const src = HD.discoverySources().find((s) => s.id === sourceId);
      if (!src) throw notFound('discovery source', sourceId);
      const m = await window.api.discoveryMetrics(sourceId);
      const known = {};
      for (const svc of (src.lastSync && src.lastSync.services) || []) if (svc.instances && svc.instances.some((i) => i.url)) known[svc.name] = svc.instances.filter((i) => i.url);
      const row = (r) => ({ service: r.service, instance: r.servedBy || r.instanceId || r.instance, requests: r.requests, share: Math.round(r.share * 1000) / 1000, p50: r.p50, p95: r.p95, ok: r.status['2xx'] + r.status['3xx'], '4xx': r.status['4xx'], '5xx': r.status['5xx'], errors: r.errors, flags: r.flags.map((x) => x.kind) });
      const payloadRows = (m.byPayload || []).map((r) => ({ ...r, instance: '', instanceId: r.payload, servedBy: '' }));
      const segmentRows = (m.bySegment || []).map((r) => ({ ...r, instance: '', instanceId: r.segment, servedBy: '' }));
      return {
        since: m.since, byInstance: HD.trafficRows(m.rows, known).map(row),
        byPayload: HD.trafficRows(payloadRows, {}, { relative: true }).map((r) => ({ ...row(r), payload: r.instanceId, instance: undefined })),
        bySegment: HD.trafficRows(segmentRows, {}, { relative: true }).map((r) => ({ ...row(r), segment: r.instanceId, instance: undefined })),
        recent: (m.recent || []).slice(0, 50),
      };
    },

    getUiState: () => {
      const t = HD.currentTab();
      return {
        ...describe(), tabs: S.ws.tabs.map((x) => ({ id: x.id, kind: x.kind, title: tabTitle(x), active: x.id === S.ws.activeTabId })),
        sidebar: S.ws.ui.sidebarHidden ? 'hidden' : S.ws.ui.sidebarTab || 'collections',
        ...(t && t.kind === 'request' ? { requestTab: (t.ui && t.ui.reqTab) || 'params', responseTab: (t.ui && t.ui.resTab) || 'body', hasResponse: S.responses.has(t.id) } : {}),
        theme: document.documentElement.dataset.theme, environment: HD.activeEnvironment() ? HD.activeEnvironment().name : null,
      };
    },
    getUiSnapshot: (args) => snapshot(args),
    uiAction: ({ body }) => act(body),
    openItem: ({ body }) => {
      const { kind, id } = body;
      if (kind === 'request') { findRequest(id); HD.openRequest(id); }
      else if (kind === 'collection' || kind === 'folder') { if (!HD.find(id)) throw notFound(kind, id); HD.openContainer(id); }
      else if (kind === 'environment') { findEnvironment(id); HD.openEnvironment(id); }
      else if (kind === 'discovery' || kind === 'traffic') { if (!HD.discoverySources().some((s) => s.id === id)) throw notFound('discovery source', id); HD.openDiscovery(id, kind === 'traffic' ? 'traffic' : 'config'); }
      else if (kind === 'runner') HD.openRunner(id || undefined);
      else throw fail(400, `Unknown kind "${kind}"`);
      return describe();
    },
    // For screenshots (main): where a region or element is, in window pixels.
    uiRect: ({ region, ref }) => {
      const el = ref ? refs.get(ref) : document.querySelector(REGIONS[region] || '');
      if (!el || !el.isConnected) throw fail(404, ref ? `Ref "${ref}" is not on screen; take a new snapshot` : `Nothing is showing in the "${region}" region`);
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.max(1, Math.ceil(Math.min(r.width, window.innerWidth - r.left))), height: Math.max(1, Math.ceil(Math.min(r.height, window.innerHeight - r.top))) };
    },
  };

  window.api.ai.onCall(async ({ id, op, args, ctx }) => {
    activeUntil = Date.now() + 2500;
    renderIndicator();
    try {
      const handler = ops[op];
      if (!handler) throw fail(501, `Not implemented: ${op}`);
      const result = await handler(args || {}, ctx || { permissions: {} });
      window.api.ai.reply({ id, ok: true, result: result === undefined ? { ok: true } : JSON.parse(JSON.stringify(result)) });
    } catch (e) {
      window.api.ai.reply({ id, ok: false, error: HD.cleanErr(e), status: e.status || 400 });
    }
  });

  // ---- Indicator and access panel ----------------------------------------------------------------

  let indicatorHost = null;
  let pulseTimer = null;
  window.api.ai.onActivity((evt) => {
    if (evt.status) status = evt.status;
    if (evt.type === 'start' || evt.type === 'call') activeUntil = Date.now() + 2500;
    renderIndicator();
    if (panelRefresh) panelRefresh();
  });

  function stateOf() {
    if (!status || !status.enabled) return null;
    if (status.error) return { key: 'error', text: 'AI access: not listening', title: status.error };
    if (status.paused) return { key: 'paused', text: 'AI paused', title: 'AI access is paused: calls are refused until you resume' };
    if (status.active || Date.now() < activeUntil) return { key: 'active', text: 'AI is working', title: 'An AI agent is using HttpDash now' };
    return { key: 'on', text: 'AI access on', title: `AI agents can connect at ${status.url}` };
  }
  HD.aiIndicator = () => {
    indicatorHost = h('span.ai-indicator-host');
    renderIndicator();
    return indicatorHost;
  };
  function renderIndicator() {
    if (!indicatorHost) return;
    HD.clear(indicatorHost);
    const st = stateOf();
    if (!st) return;
    indicatorHost.appendChild(h(`button.btn.btn-ghost.btn-small.ai-indicator.ai-${st.key}`, { type: 'button', title: `${st.title}. Click for the access history.`, onclick: () => HD.showAiAccess() },
      h('span.ai-dot'), h('span', st.text)));
    clearTimeout(pulseTimer);
    if (st.key === 'active') pulseTimer = setTimeout(renderIndicator, Math.max(200, activeUntil - Date.now() + 50));
  }

  let panelRefresh = null;
  HD.showAiAccess = async () => {
    const body = h('div.ai-access');
    const draw = async () => {
      const items = await window.api.ai.log(200);
      const st = stateOf();
      HD.clear(body).append(
        h('div.ai-access-head',
          st ? h(`span.ai-indicator.ai-${st.key}`, h('span.ai-dot'), h('span', st.text)) : h('span.muted', 'AI access is off'),
          h('span.spacer'),
          status && status.enabled ? HD.button(status.paused ? 'Resume' : 'Pause', async () => { const s = HD.aiSettings(); s.paused = !s.paused; HD.save(); await HD.aiConfigure(); draw(); }, { small: true }) : null,
          HD.button('Settings', () => { close(); HD.showSettings('ai'); }, { small: true, ghost: true })),
        items.length ? h('div.table-wrap.no-pad', h('table.data-table.ai-log',
          h('thead', h('tr', h('th', 'Time'), h('th', 'Operation'), h('th', 'Permission'), h('th', 'Result'), h('th.num', 'Time'), h('th', 'Client'))),
          h('tbody', items.map((e) => h('tr',
            h('td.mono.small', new Date(e.time).toLocaleTimeString()),
            h('td.mono', e.op || `${e.method} ${e.path}`),
            h('td', e.permission && e.permission !== '-' ? h(`span.pill.ai-perm-${e.permission}`, e.permission) : null),
            h('td', e.status === 200 ? h('span.text-ok.small', e.summary || 'OK') : h('span.text-error.small', `${e.status} ${e.error || ''}`)),
            h('td.num.small', e.ms != null ? HD.formatMs(e.ms) : ''),
            h('td.small.muted', e.client || '')))))) : h('div.empty-state.small', h('div', 'No calls yet.'), h('div.muted', 'Every call an AI agent makes appears here, newest first.')));
    };
    const { close } = HD.modal({ title: 'AI access', body, width: 860, onClose: () => { panelRefresh = null; } });
    panelRefresh = HD.debounce(() => { if (body.isConnected) draw(); else panelRefresh = null; }, 300);
    draw();
  };

  // ---- Settings → AI access ----------------------------------------------------------------------

  HD.aiSettingsPanel = (panel, rerender) => {
    const s = HD.aiSettings();
    const apply = async () => { HD.save(); await HD.aiConfigure(); rerender(); };
    const perm = (key, label, help, danger) => h('label.check.ai-perm', h('input', { type: 'checkbox', checked: !!s.permissions[key], disabled: key === 'read', onchange: (e) => { s.permissions[key] = e.target.checked; apply(); } }),
      h('span', h('b', label), h('span.muted.small', ` · ${help}`)), danger ? h('span.pill.removed.small', danger) : null);
    panel.append(
      h('div.setting-row',
        h('div', h('div.setting-label', 'Let AI agents use HttpDash'), h('div.setting-help', 'An API on this computer only (127.0.0.1), described by an OpenAPI document, that AI agents such as Claude can call with a token: read your requests, send them, run the Runner, and see and use the screen, as you allow below. Off until you turn it on.')),
        h('label.switch', h('input', { type: 'checkbox', checked: !!s.enabled, onchange: (e) => { s.enabled = e.target.checked; apply(); } }), h('span.slider'))),
      h('div.setting-row', h('div', h('div.setting-label', 'Port'), h('div.setting-help', 'Where the API listens, on this computer only.')),
        h('input.input.input-small', { type: 'number', min: 1024, max: 65535, value: s.port, onchange: (e) => { s.port = Number(e.target.value) || 47823; apply(); } })),
      h('div.section-title', 'What agents may do'),
      perm('read', 'Read', 'collections, requests, environments, history, results (always on)'),
      perm('run', 'Run', 'send requests, run the Runner, compare instances, sync discovery'),
      perm('edit', 'Edit', 'create, change and delete requests; set variables; switch environment'),
      perm('ui', 'Control the screen', 'screenshots, see the controls on screen, click, type and scroll'),
      perm('secrets', 'Reveal secrets', 'secret variables and credentials unmasked', 'sensitive'));
    if (s.enabled) {
      const tokenBox = h('code.ai-token', '••••••••••••••••••••••••');
      const url = (status && status.url) || `http://127.0.0.1:${s.port}`;
      panel.append(
        h('div.section-title', 'Connect an agent'),
        status && status.error ? h('div.test-script-error', status.error) : null,
        h('div.setting-row', h('div', h('div.setting-label', 'OpenAPI document'), h('div.setting-help.mono', `${url}/openapi.json`)), HD.button('Copy', () => HD.copy(`${url}/openapi.json`), { small: true })),
        h('div.setting-row', h('div', h('div.setting-label', 'Token'), tokenBox, h('div.setting-help', 'Send it as "Authorization: Bearer <token>". A new token locks out whoever had the old one.')),
          h('div.button-row',
            HD.button('Show', async () => { tokenBox.textContent = await window.api.ai.token(); }, { small: true, ghost: true }),
            HD.button('Copy', async () => HD.copy(await window.api.ai.token()), { small: true }),
            HD.button('New token', async () => { if (await HD.confirm('New token', 'Agents using the current token will be refused until they get the new one.', { okLabel: 'Make a new token' })) { await window.api.ai.regenerate(); rerender(); } }, { small: true, danger: true }))),
        h('div.setting-row', h('div', h('div.setting-label', 'Claude (MCP)'),
          h('div.setting-help', 'With the HttpDash CLI installed, Claude Code connects with:'), h('code.ai-snippet', 'claude mcp add httpdash -- httpdash mcp'),
          h('div.setting-help', 'For Claude Desktop, add to claude_desktop_config.json:'), h('code.ai-snippet', JSON.stringify({ mcpServers: { httpdash: { command: 'httpdash', args: ['mcp'] } } })),
          h('div.setting-help', 'The MCP server finds the port and token by itself while HttpDash is running.'))),
        h('div.button-row', HD.button('AI access history', () => HD.showAiAccess(), { small: true, icon: 'history' })));
    }
  };
})();
