'use strict';

/* gRPC requests: pick a method from .proto files or server reflection, send a JSON message, and
   watch what comes back. Saved like any request (protocol "grpc", method "GRPC"); calls and their
   logs live per tab. Client and bidirectional streaming calls stay open: send messages one at a
   time, then End stream. */
(() => {
  const { h } = HD;
  const S = HD.S;
  const LOG_LIMIT = 5000;

  HD.newGrpcDef = (o = {}) => HD.newRequestDef({
    protocol: 'grpc', method: 'GRPC', url: '', auth: { type: 'inherit' },
    grpc: { source: 'reflection', protoFiles: [], importPaths: [], service: '', method: '', message: '{\n  \n}', tls: 'auto', deadlineMs: '' },
    ...o,
  });
  HD.isGrpc = (req) => !!req && req.protocol === 'grpc';
  HD.openNewGrpc = () => HD.openNewRequest(HD.newGrpcDef(), 'Untitled gRPC');

  const KIND_LABEL = { unary: 'unary', 'server-stream': 'server streaming', 'client-stream': 'client streaming', bidi: 'bidirectional streaming' };
  const streamsIn = (kind) => kind === 'client-stream' || kind === 'bidi';

  // Per tab: { state: 'idle'|'starting'|'running', kind, log, status, view }.
  const live = new Map();
  const callOf = (tabId) => {
    if (!live.has(tabId)) live.set(tabId, { state: 'idle', log: [], view: null });
    return live.get(tabId);
  };
  // Methods per definition (by target or .proto files), read once a session unless refreshed.
  const definitions = new Map(); // key -> { services, error, loading }

  const push = (c, entry) => {
    c.log.push({ time: Date.now(), ...entry });
    if (c.log.length > LOG_LIMIT) c.log.splice(0, c.log.length - LOG_LIMIT);
    if (c.view) c.view.append(c.log[c.log.length - 1]);
  };

  window.api.grpc.onEvent((evt) => {
    const c = live.get(evt.id);
    if (!c) return;
    if (evt.type === 'headers') push(c, { kind: 'info', text: `Response headers (${evt.headers.length})`, pairs: evt.headers });
    else if (evt.type === 'message') push(c, { dir: evt.dir, text: JSON.stringify(evt.message) });
    else if (evt.type === 'status') {
      c.state = 'idle';
      c.status = evt;
      const ok = evt.code === 0;
      push(c, { kind: ok ? 'open' : 'error', text: `${evt.code} ${evt.name}${evt.details && evt.details !== 'OK' ? `: ${evt.details}` : ''} · ${HD.formatMs(evt.time)}`, pairs: evt.trailers, pairsTitle: 'Trailers' });
    }
    if (c.view) c.view.status();
    HD.renderTabBar();
  });

  HD.grpcState = (tabId) => (live.get(tabId) || {}).state || 'idle';
  HD.closeGrpcTab = (tabId) => {
    const c = live.get(tabId);
    if (c && c.state !== 'idle') window.api.grpc.cancel({ id: tabId });
    live.delete(tabId);
  };

  const clean = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
  const clock = (t) => { const d = new Date(t); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
  const base = (p) => String(p).split(/[\\/]/).pop();

  HD.views.grpc = (tab, root) => {
    const draft = tab.draft;
    const req = draft.request;
    // Defaults go into the request's own object: a view drawn earlier may still write to it.
    const g = (req.grpc = req.grpc || {});
    for (const [k, v] of Object.entries({ source: 'reflection', protoFiles: [], importPaths: [], service: '', method: '', message: '', tls: 'auto', deadlineMs: '' })) if (g[k] === undefined) g[k] = v;
    tab.ui = tab.ui || {};
    const ui = tab.ui;
    const c = callOf(tab.id);

    const context = () => {
      const found = HD.find(tab.refId);
      if (!found) return { collection: null, chain: [] };
      return { collection: found.collection, chain: [found.collection, ...found.parents], found };
    };
    HD.variableInfo = () => HD.variableInfoFor(context().collection);
    const markDirty = () => { HD.pinTab(tab); if (!tab.dirty) { tab.dirty = true; HD.renderTabBar(); } HD.save(); HD.recordEdit(tab); };
    const params = (extra = {}) => {
      const { collection, chain } = context();
      return {
        id: tab.id, request: HD.clone(req), scopes: HD.scopesFor(collection),
        settings: { ...S.ws.settings, tunnelId: HD.tunnelIdFor(HD.activeEnvironment()) },
        chain: chain.map((n) => ({ id: n.id, name: n.name, auth: n.auth })), ...extra,
      };
    };
    // The editor reports typing; a message put in by a button is copied over here.
    let msgCm = null;
    const syncMessage = () => { if (msgCm && msgCm.getValue() !== g.message) { g.message = msgCm.getValue(); markDirty(); } };
    const setMessage = (text) => { g.message = text; markDirty(); if (msgCm) msgCm.setValue(text); };
    const sameJson = (text, obj) => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(obj); } catch { return false; } };
    const defKey = () => (g.source === 'proto' ? `proto ${g.protoFiles.join('|')} ${g.importPaths.join('|')}` : `reflect ${g.tls} ${req.url.trim()}`);
    const defs = () => definitions.get(defKey()) || null;
    const method = () => {
      const d = defs();
      const svc = d && d.services && d.services.find((s) => s.name === g.service);
      return svc ? svc.methods.find((m) => m.name === g.method) || null : null;
    };

    // Header and address bar.
    const ctx = context();
    const crumbs = ctx.found ? [ctx.collection.name, ...ctx.found.parents.map((p) => p.name)] : [];
    const header = h('div.req-header',
      h('div.breadcrumb', crumbs.map((x) => h('span.crumb', x)), h('input.title-input', { 'aria-label': 'Name', value: draft.name, spellcheck: 'false', oninput: (e) => { draft.name = e.target.value; markDirty(); } })),
      h('div.req-header-actions', HD.button('Save', () => HD.saveTab(tab), { icon: 'download', small: true, title: 'Save (Ctrl+S)' })));
    const urlHost = h('div.url-input');
    const methodHost = h('div.grpc-method');
    const goBtn = h('button.btn.send-btn', { type: 'button', onclick: () => go() });
    const urlBar = h('div.url-bar', h('span.ws-tag.grpc-tag', 'gRPC'), urlHost, methodHost, goBtn);

    const renderMethod = () => {
      HD.clear(methodHost);
      const d = defs();
      const opts = [];
      if (d && d.services) for (const s of d.services) for (const m of s.methods) opts.push([`${s.name}/${m.name}`, `${s.name.split('.').pop()} / ${m.name}${m.kind !== 'unary' ? ` (${KIND_LABEL[m.kind]})` : ''}`]);
      const current = g.service && g.method ? `${g.service}/${g.method}` : '';
      if (current && !opts.some(([v]) => v === current)) opts.unshift([current, `${g.service.split('.').pop()} / ${g.method}`]);
      if (!opts.length) opts.push(['', d && d.loading ? 'Loading methods…' : 'Select a method']);
      const sel = HD.select(opts, current, (v) => {
        syncMessage();
        const before = method();
        const i = v.lastIndexOf('/');
        g.service = v.slice(0, i);
        g.method = v.slice(i + 1);
        markDirty();
        // A message that is empty, or still the last method's example, becomes this method's example.
        const m = method();
        if (m && (!/[^\s{}]/.test(g.message || '') || (before && sameJson(g.message, before.example)))) setMessage(JSON.stringify(m.example, null, 2));
        status();
        renderPanel();
      }, 'grpc-method-select');
      sel.setAttribute('aria-label', 'Method');
      methodHost.append(sel, HD.button('', () => load(true), { icon: 'refresh', ghost: true, small: true, title: g.source === 'proto' ? 'Read the .proto files again' : 'Ask the server again (reflection)' }));
    };

    const load = async (refresh = false) => {
      if (g.source !== 'proto' && !req.url.trim()) return;
      if (g.source === 'proto' && !g.protoFiles.length) return;
      const key = defKey();
      const before = definitions.get(key);
      if (before && before.loading) return;
      if (before && before.services && !refresh) return;
      definitions.set(key, { loading: true });
      renderMethod();
      renderPanel();
      try {
        const r = await window.api.grpc.describe(params({ refresh }));
        definitions.set(key, { services: r.services });
        // Nothing picked yet: the first method.
        if (!g.service && r.services.length && r.services[0].methods.length) {
          g.service = r.services[0].name;
          g.method = r.services[0].methods[0].name;
          if (!/[^\s{}]/.test(g.message || '')) setMessage(JSON.stringify(r.services[0].methods[0].example, null, 2));
          markDirty();
        }
      } catch (e) {
        definitions.set(key, { error: clean(e) });
      }
      // The tab may have been drawn again meanwhile: update the drawing that's showing.
      const now = callOf(tab.id);
      if (now.refreshDefinitions) now.refreshDefinitions(key);
    };

    // Message / Metadata / Definition / Settings.
    const tabsHost = h('div.req-tabs-host');
    const panel = h('div.req-panel.ws-panel');
    const tabs = () => [
      { id: 'message', label: 'Message' },
      { id: 'metadata', label: 'Metadata', badge: req.headers.filter((p) => p.enabled !== false && p.key).length || null },
      { id: 'definition', label: 'Definition', dot: g.source === 'proto' },
      { id: 'settings', label: 'Settings', dot: g.tls !== 'auto' || !!String(g.deadlineMs || '').trim() },
    ];
    const renderTabs = () => HD.clear(tabsHost).appendChild(HD.tabStrip(tabs(), ui.grpcTab || 'message', (id) => { syncMessage(); ui.grpcTab = id; HD.save(); renderTabs(); renderPanel(); }));
    const renderPanel = () => {
      HD.clear(panel);
      msgCm = null;
      const t = ui.grpcTab || 'message';
      if (t === 'message') {
        const m = method();
        const kind = c.state !== 'idle' ? c.kind : m && m.kind;
        const open = c.state === 'running' && streamsIn(c.kind);
        const edHost = h('div.ws-editor');
        panel.append(edHost, h('div.ws-msg-bar',
          h('span.muted.small', m ? `${m.requestType} → ${m.responseType}${streamsIn(kind) ? ' · start the call, then send messages one at a time' : ''}` : '{{variables}} are filled in when the message is sent'),
          h('span.spacer'),
          m ? HD.button('Example', () => { setMessage(JSON.stringify(m.example, null, 2)); msgCm.focus(); }, { small: true, ghost: true, title: 'Fill in every field of the message with its default' }) : null,
          open ? HD.button('End stream', () => window.api.grpc.end({ id: tab.id }), { small: true, ghost: true, title: 'Tell the server no more messages are coming' }) : null,
          open ? HD.button('Send', () => sendMessage(), { primary: true, small: true, title: 'Send this message (Ctrl+Enter)' }) : null));
        msgCm = HD.editor(edHost, {
          value: g.message || '', mode: 'json', variables: true, placeholder: 'The request message as JSON. Field names as in the .proto, or in lowerCamelCase.',
          onChange: (v) => { g.message = v; markDirty(); },
        });
      } else if (t === 'metadata') {
        panel.appendChild(HD.kvTable({ title: 'Metadata', rows: req.headers, keyPlaceholder: 'Key (lowercase; -bin keys take base64)', onChange: () => { markDirty(); renderTabs(); } }));
        panel.appendChild(h('div.panel-pad.muted.small', 'Auth from the collection or folder (Bearer, Basic, API key…) is sent as metadata, such as authorization: Bearer …'));
      } else if (t === 'definition') {
        const d = defs();
        const files = g.protoFiles.map((f, i) => h('span.ws-chip', { title: f }, h('span.grpc-chip-name', base(f)),
          h('button.ws-chip-del', { type: 'button', title: 'Remove', onclick: () => { g.protoFiles.splice(i, 1); markDirty(); renderPanel(); load(); } }, '×')));
        const dirs = g.importPaths.map((f, i) => h('span.ws-chip', { title: f }, h('span.grpc-chip-name', f),
          h('button.ws-chip-del', { type: 'button', title: 'Remove', onclick: () => { g.importPaths.splice(i, 1); markDirty(); renderPanel(); load(true); } }, '×')));
        const state = !d ? null : d.loading ? h('div.muted.small', 'Loading…')
          : d.error ? h('div.text-error.small', d.error)
            : h('div.muted.small', `${d.services.length} service${d.services.length === 1 ? '' : 's'}, ${d.services.reduce((n, s) => n + s.methods.length, 0)} methods: ${d.services.map((s) => s.name).join(', ')}`);
        panel.appendChild(h('div.panel-pad.grpc-def',
          h('div.grpc-def-source', HD.tabStrip([{ id: 'reflection', label: 'Server reflection' }, { id: 'proto', label: '.proto files' }], g.source, (id) => { g.source = id; markDirty(); renderTabs(); renderPanel(); renderMethod(); load(); }, 'segmented')),
          g.source === 'proto'
            ? [
              h('div.grpc-def-row', h('span.grpc-def-label', 'Files'), h('div.ws-saved', files.length ? files : h('span.muted.small', 'None yet')),
                HD.button('Add .proto files', async () => {
                  const picked = await window.api.openFile({ multi: true, filters: [{ name: 'Protocol Buffers', extensions: ['proto'] }] });
                  const add = (picked || []).filter((p) => !g.protoFiles.includes(p));
                  if (!add.length) return;
                  g.protoFiles.push(...add);
                  markDirty(); renderPanel(); load(true);
                }, { small: true, icon: 'file' })),
              h('div.grpc-def-row', h('span.grpc-def-label', 'Import paths'), h('div.ws-saved', dirs.length ? dirs : h('span.muted.small', 'The files\' own folders')),
                HD.button('Add folder', async () => {
                  const dir = await window.api.openFolder({ title: 'Folder that imports are relative to' });
                  if (!dir || g.importPaths.includes(dir)) return;
                  g.importPaths.push(dir);
                  markDirty(); renderPanel(); load(true);
                }, { small: true, icon: 'folder' })),
              h('div.muted.small', 'Imports are looked up next to the importing file, then in these folders. Google\'s well-known types (google/protobuf/*.proto) are built in. The paths are of this computer, so teammates add their own.'),
            ]
            : h('div.muted.small', 'HttpDash asks the server at the address above for its services and their messages (gRPC server reflection, v1 or v1alpha). Use .proto files for a server that doesn\'t offer it.'),
          state));
      } else {
        panel.appendChild(h('div.panel-pad',
          h('label.field', h('span', 'TLS'), HD.select([['auto', 'From the address (grpcs:// or https:// means TLS)'], ['on', 'On'], ['off', 'Off (plaintext)']], g.tls, (v) => { g.tls = v; markDirty(); renderTabs(); load(); })),
          h('label.field', h('span', 'Deadline (ms)'), h('input.input.input-small', { type: 'number', min: 0, value: g.deadlineMs || '', placeholder: String(S.ws.settings.timeout || 'none'), oninput: (e) => { g.deadlineMs = e.target.value; markDirty(); renderTabs(); } })),
          h('div.muted.small', 'With TLS, client certificates, trusted CAs and SSL verification from Settings apply. Proxies and tunnels don\'t apply to gRPC yet.')));
      }
    };

    // The log of the call.
    const logList = h('div.ws-log-list');
    const statusPill = h('span.ws-status');
    const counts = h('span.muted.small');
    const logBar = h('div.ws-log-bar', statusPill, counts, h('span.spacer'),
      HD.button('Clear', () => { c.log = []; redraw(); status(); }, { small: true, ghost: true }));
    const row = (e) => {
      if (e.kind) {
        const r = h(`div.ws-row.ws-${e.kind}`, h('span.ws-time', clock(e.time)), h('span.ws-dir', e.kind === 'error' ? '!' : '●'), h('span.ws-text', e.text));
        if (e.pairs && e.pairs.length) {
          r.classList.add('expandable');
          r.onclick = () => { if (r.nextSibling && r.nextSibling.classList && r.nextSibling.classList.contains('ws-detail')) r.nextSibling.remove(); else r.after(h('div.ws-detail', h('pre', [e.pairsTitle || '', ...e.pairs.map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n')))); };
        }
        return r;
      }
      const r = h(`div.ws-row.ws-${e.dir}.expandable`,
        h('span.ws-time', clock(e.time)),
        h('span.ws-dir', { title: e.dir === 'in' ? 'Received' : 'Sent' }, e.dir === 'in' ? '↓' : '↑'),
        h('span.ws-text', e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text));
      r.onclick = () => {
        const next = r.nextSibling;
        if (next && next.classList && next.classList.contains('ws-detail')) { next.remove(); return; }
        r.after(h('div.ws-detail', h('div.ws-detail-actions', HD.button('Copy', (ev) => { ev.stopPropagation(); HD.copy(pretty(e.text)); }, { small: true, ghost: true })), h('pre', pretty(e.text))));
      };
      // A single answer (unary) opens straight away.
      if (e.dir === 'in' && c.kind === 'unary') setTimeout(() => r.isConnected && !(r.nextSibling && r.nextSibling.classList.contains('ws-detail')) && r.onclick(), 0);
      return r;
    };
    const append = (e) => {
      const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
      if (logList.querySelector('.empty-state')) HD.clear(logList);
      logList.appendChild(row(e));
      if (atBottom) logList.scrollTop = logList.scrollHeight;
      status();
    };
    const redraw = () => {
      HD.clear(logList);
      if (!c.log.length) logList.appendChild(h('div.empty-state.small', 'Pick a method and press Invoke. What is sent and received appears here.'));
      for (const e of c.log) logList.appendChild(row(e));
      logList.scrollTop = logList.scrollHeight;
    };
    const status = () => {
      const st = c.state === 'idle' ? (c.status ? (c.status.code === 0 ? 'open' : 'error') : 'idle') : 'connecting';
      statusPill.textContent = c.state === 'starting' ? 'Starting…' : c.state === 'running' ? (streamsIn(c.kind) ? 'Open: send messages, then End stream' : 'Waiting for the server…') : c.status ? c.status.name : 'Idle';
      statusPill.className = `ws-status ws-status-${st === 'error' ? 'closing' : st}`;
      const sent = c.log.filter((e) => e.dir === 'out').length;
      const got = c.log.filter((e) => e.dir === 'in').length;
      counts.textContent = c.log.length ? `↑ ${sent}  ↓ ${got}` : '';
      const m = method();
      const startsOpen = m && streamsIn(m.kind);
      goBtn.textContent = c.state === 'idle' ? (startsOpen ? 'Start' : 'Invoke') : 'Cancel';
      goBtn.className = `btn send-btn ${c.state === 'idle' ? 'btn-primary' : 'btn-danger'}`;
    };
    c.view = { append, status };
    c.refreshDefinitions = (key) => {
      if (key !== defKey() || !methodHost.isConnected) return;
      renderMethod();
      status();
      // Redraw the panel unless someone is typing in it.
      if (!panel.contains(document.activeElement)) renderPanel();
    };

    const go = async () => {
      if (c.state !== 'idle') { window.api.grpc.cancel({ id: tab.id }); return; }
      syncMessage();
      if (!req.url.trim()) { HD.toast('Enter the server address, such as localhost:50051', 'warn'); return; }
      if (!g.service || !g.method) { HD.toast('Pick a method first', 'warn'); return; }
      HD.pinTab(tab);
      c.log = [];
      c.status = null;
      redraw();
      c.state = 'starting';
      status();
      try {
        const r = await window.api.grpc.start(params());
        c.kind = r.kind;
        if (c.state === 'starting') c.state = 'running';
        push(c, { kind: 'info', text: `${r.path} on ${r.target} (${KIND_LABEL[r.kind]})${r.metadata.length ? ` · ${r.metadata.length} metadata` : ''}`, pairs: r.metadata, pairsTitle: 'Metadata sent' });
      } catch (e) {
        c.state = 'idle';
        push(c, { kind: 'error', text: clean(e) });
      }
      status();
      if ((ui.grpcTab || 'message') === 'message') renderPanel();
      HD.renderTabBar();
    };

    const sendMessage = async () => {
      if (!(c.state === 'running' && streamsIn(c.kind))) return go();
      try {
        await window.api.grpc.write({ id: tab.id, text: msgCm ? msgCm.getValue() : g.message, scopes: HD.scopesFor(context().collection) });
      } catch (e) {
        push(c, { kind: 'error', text: `Not sent: ${clean(e)}` });
      }
    };

    const top = h('div.ws-top', header, urlBar, tabsHost, panel);
    root.append(h('div.ws-view', top, h('div.ws-log', logBar, logList)));
    // Ctrl/Cmd+Enter invokes; in an open streaming call, it sends the message.
    S.senders.set(tab.id, () => sendMessage());
    HD.lineEditor(urlHost, {
      value: req.url, placeholder: 'localhost:50051 or grpcs://api.example.com',
      onEnter: () => load(true),
      onChange: (v) => { req.url = v; markDirty(); HD.renderTabBar(); },
    });
    urlHost.addEventListener('focusout', () => { if (g.source !== 'proto') load(); });
    renderMethod();
    renderTabs();
    renderPanel();
    redraw();
    status();
    load();
    HD.trackEdits(tab);
  };
})();
