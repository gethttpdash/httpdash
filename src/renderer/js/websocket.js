'use strict';

/* WebSocket requests: connect, send messages, and watch a live log of what goes each way.
   Saved like any request (protocol "websocket", method "WS"); connections and logs live per tab. */
(() => {
  const { h } = HD;
  const S = HD.S;
  const LOG_LIMIT = 5000; // messages kept per tab
  const DOM_LIMIT = 1000; // log rows kept on screen; older ones are dropped from view, not from the log

  HD.newWebSocketDef = (o = {}) => HD.newRequestDef({ protocol: 'websocket', method: 'WS', url: '', auth: { type: 'inherit' }, ws: { protocols: '', messages: [] }, ...o });
  HD.isWebSocket = (req) => !!req && req.protocol === 'websocket';
  HD.openNewWebSocket = () => HD.openNewRequest(HD.newWebSocketDef(), 'Untitled WebSocket');

  // Connection state per tab: { state, log, handshake, url, sent, received, view }.
  const live = new Map();
  const conn = (tabId) => {
    if (!live.has(tabId)) live.set(tabId, { state: 'idle', log: [], sent: 0, received: 0, view: null });
    return live.get(tabId);
  };

  const push = (c, entry) => {
    c.log.push({ time: Date.now(), ...entry });
    if (c.log.length > LOG_LIMIT) c.log.splice(0, c.log.length - LOG_LIMIT);
    if (c.view) c.view.append(c.log[c.log.length - 1]);
  };

  window.api.ws.onEvent((evt) => {
    const c = live.get(evt.id);
    if (!c) return;
    if (evt.type === 'message') {
      c.received++;
      push(c, { dir: 'in', text: evt.binary ? null : evt.data, base64: evt.binary ? evt.data : null, size: evt.size, time: evt.time });
    } else if (evt.type === 'ping') push(c, { kind: 'info', text: 'Ping received (answered automatically)' });
    else if (evt.type === 'error') push(c, { kind: 'error', text: evt.message });
    else if (evt.type === 'close') {
      c.state = 'idle';
      push(c, { kind: 'close', text: `Disconnected: ${evt.code}${evt.label ? ` ${evt.label}` : ''}${evt.reason ? ` (${evt.reason})` : ''}` });
    }
    if (c.view) c.view.status();
    HD.renderTabBar();
  });

  HD.wsState = (tabId) => (live.get(tabId) || {}).state || 'idle';
  HD.closeWebSocketTab = (tabId) => {
    const c = live.get(tabId);
    if (c && c.state !== 'idle') window.api.ws.close({ id: tabId, code: 1000, reason: 'Tab closed' });
    live.delete(tabId);
  };

  const clean = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
  const clock = (t) => { const d = new Date(t); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

  HD.views.websocket = (tab, root) => {
    const draft = tab.draft;
    const req = draft.request;
    req.ws = req.ws || { protocols: '', messages: [] };
    req.ws.messages = req.ws.messages || [];
    tab.ui = tab.ui || {};
    const ui = tab.ui;
    const c = conn(tab.id);

    const context = () => {
      const found = HD.find(tab.refId);
      if (!found) return { collection: null, chain: [] };
      return { collection: found.collection, chain: [found.collection, ...found.parents], found };
    };
    HD.variableInfo = () => HD.variableInfoFor(context().collection);
    const markDirty = () => { HD.pinTab(tab); if (!tab.dirty) { tab.dirty = true; HD.renderTabBar(); } HD.save(); };

    // Header and URL bar.
    const ctx = context();
    const crumbs = ctx.found ? [ctx.collection.name, ...ctx.found.parents.map((p) => p.name)] : [];
    const header = h('div.req-header',
      h('div.breadcrumb', crumbs.map((x) => h('span.crumb', x)), h('input.title-input', { 'aria-label': 'Name', value: draft.name, spellcheck: 'false', oninput: (e) => { draft.name = e.target.value; markDirty(); } })),
      h('div.req-header-actions', HD.button('Save', () => HD.saveTab(tab), { icon: 'download', small: true, title: 'Save (Ctrl+S)' })));
    const urlHost = h('div.url-input');
    const connectBtn = h('button.btn.send-btn', { type: 'button', onclick: () => toggle() });
    const urlBar = h('div.url-bar', h('span.ws-tag', 'WS'), urlHost, connectBtn);

    // Message / Headers / Settings.
    const tabsHost = h('div.req-tabs-host');
    const panel = h('div.req-panel.ws-panel');
    const tabs = () => [
      { id: 'message', label: 'Message' },
      { id: 'headers', label: 'Headers', badge: req.headers.filter((p) => p.enabled !== false && p.key).length || null },
      { id: 'settings', label: 'Settings', dot: !!(req.ws.protocols || '').trim() },
    ];
    const renderTabs = () => HD.clear(tabsHost).appendChild(HD.tabStrip(tabs(), ui.wsTab || 'message', (id) => { ui.wsTab = id; HD.save(); renderTabs(); renderPanel(); }));
    let msgCm;
    const renderPanel = () => {
      HD.clear(panel);
      const t = ui.wsTab || 'message';
      if (t === 'message') {
        const edHost = h('div.ws-editor');
        const saved = h('div.ws-saved', req.ws.messages.length ? [h('span.muted.small', 'Saved:'), ...req.ws.messages.map((m, i) => h('span.ws-chip',
          h('button.ws-chip-load', { type: 'button', title: 'Put this message in the editor', onclick: () => { msgCm.setValue(m.body); msgCm.focus(); } }, m.name),
          h('button.ws-chip-del', { type: 'button', title: 'Delete saved message', onclick: () => { req.ws.messages.splice(i, 1); markDirty(); renderPanel(); } }, '×')))] : null);
        panel.append(edHost, h('div.ws-msg-bar',
          saved,
          h('span.spacer'),
          HD.button('Save message', async () => {
            const body = msgCm.getValue();
            if (!body.trim()) return;
            const name = await HD.prompt('Save message', 'Name', body.trim().slice(0, 24));
            if (!name) return;
            req.ws.messages.push({ id: HD.uid(), name, body });
            markDirty();
            renderPanel();
          }, { small: true, ghost: true }),
          HD.button('Send', () => sendMessage(), { primary: true, small: true, title: 'Send (Ctrl+Enter)' })));
        msgCm = HD.editor(edHost, {
          value: ui.wsDraft || '', mode: 'json', placeholder: 'Message to send. {{variables}} are filled in when it is sent.', variables: true,
          onChange: (v) => { ui.wsDraft = v; HD.save(); },
          extraKeys: { 'Ctrl-Enter': () => sendMessage(), 'Cmd-Enter': () => sendMessage() },
        });
      } else if (t === 'headers') {
        panel.appendChild(HD.kvTable({ title: 'Handshake headers', rows: req.headers, onChange: () => { markDirty(); renderTabs(); } }));
        panel.appendChild(h('div.panel-pad.muted.small', 'Auth from the collection or folder (Bearer, Basic, API key, OAuth 2.0…) and matching cookies are added to the handshake automatically.'));
      } else {
        panel.appendChild(h('div.panel-pad',
          h('label.field', h('span', 'Subprotocols'),
            h('input.input', { value: req.ws.protocols || '', placeholder: 'e.g. graphql-transport-ws, v2.json (comma-separated)', spellcheck: 'false', oninput: (e) => { req.ws.protocols = e.target.value; markDirty(); renderTabs(); } })),
          h('div.muted.small', 'Sent as Sec-WebSocket-Protocol; the server picks one. Client certificates, trusted CAs, the proxy and SSL verification from Settings apply to the connection.')));
      }
    };

    // The log.
    const logList = h('div.ws-log-list');
    const statusPill = h('span.ws-status');
    const counts = h('span.muted.small');
    let filter = '';
    const logBar = h('div.ws-log-bar', statusPill, counts, h('span.spacer'),
      h('input.input.ws-filter', { type: 'search', placeholder: 'Filter messages', spellcheck: 'false', oninput: HD.debounce((e) => { filter = e.target.value.trim().toLowerCase(); redraw(); }, 150) }),
      HD.button('Clear', () => { c.log = []; c.sent = 0; c.received = 0; redraw(); status(); }, { small: true, ghost: true }));

    const row = (e) => {
      if (e.kind) {
        const extra = e.handshake ? h('div.ws-detail', h('pre', [`GET ${e.url}`, ...e.handshake.sentHeaders.map(([k, v]) => `${k}: ${v}`), '', `HTTP/1.1 ${e.handshake.status} ${e.handshake.statusText}`, ...e.handshake.headers.map(([k, v]) => `${k}: ${v}`)].join('\n'))) : null;
        const r = h(`div.ws-row.ws-${e.kind}`, h('span.ws-time', clock(e.time)), h('span.ws-dir', e.kind === 'error' ? '!' : '●'), h('span.ws-text', e.text));
        if (extra) {
          r.classList.add('expandable');
          r.onclick = () => { if (r.nextSibling && r.nextSibling.classList && r.nextSibling.classList.contains('ws-detail')) r.nextSibling.remove(); else r.after(extra); };
        }
        return r;
      }
      const text = e.text != null ? e.text : `Binary message (${HD.formatBytes(e.size)}), base64: ${e.base64.slice(0, 120)}${e.base64.length > 120 ? '…' : ''}`;
      const r = h(`div.ws-row.ws-${e.dir}.expandable`,
        h('span.ws-time', clock(e.time)),
        h('span.ws-dir', { title: e.dir === 'in' ? 'Received' : 'Sent' }, e.dir === 'in' ? '↓' : '↑'),
        h('span.ws-text', text.length > 400 ? `${text.slice(0, 400)}…` : text),
        h('span.ws-size.muted', HD.formatBytes(e.size)));
      r.onclick = () => {
        const next = r.nextSibling;
        if (next && next.classList && next.classList.contains('ws-detail')) { next.remove(); return; }
        const full = e.text != null ? pretty(e.text) : e.base64;
        r.after(h('div.ws-detail', h('div.ws-detail-actions', HD.button('Copy', (ev) => { ev.stopPropagation(); HD.copy(e.text != null ? e.text : e.base64); }, { small: true, ghost: true })), h('pre', full)));
      };
      return r;
    };
    const visible = (e) => !filter || String(e.text || '').toLowerCase().includes(filter);
    const append = (e) => {
      if (!visible(e)) { status(); return; }
      const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
      logList.appendChild(row(e));
      while (logList.childElementCount > DOM_LIMIT) logList.firstElementChild.remove();
      if (atBottom) logList.scrollTop = logList.scrollHeight;
      status();
    };
    const redraw = () => {
      HD.clear(logList);
      const rows = c.log.filter(visible).slice(-DOM_LIMIT);
      if (!rows.length) logList.appendChild(h('div.empty-state.small', c.log.length ? 'No messages match the filter.' : 'Connect, then send a message. Everything sent and received appears here.'));
      for (const e of rows) logList.appendChild(row(e));
      logList.scrollTop = logList.scrollHeight;
    };
    const status = () => {
      const labels = { idle: 'Disconnected', connecting: 'Connecting…', open: 'Connected', closing: 'Closing…' };
      statusPill.textContent = labels[c.state];
      statusPill.className = `ws-status ws-status-${c.state}`;
      counts.textContent = `↑ ${c.sent}  ↓ ${c.received}`;
      connectBtn.textContent = c.state === 'idle' ? 'Connect' : c.state === 'connecting' ? 'Cancel' : 'Disconnect';
      connectBtn.className = `btn send-btn ${c.state === 'idle' ? 'btn-primary' : 'btn-danger'}`;
      if (logList.querySelector('.empty-state') && c.log.length) redraw();
    };
    c.view = { append, status };

    const toggle = async () => {
      if (c.state === 'open' || c.state === 'closing') {
        c.state = 'closing';
        status();
        await window.api.ws.close({ id: tab.id, code: 1000, reason: '' });
        return;
      }
      if (c.state === 'connecting') { window.api.ws.close({ id: tab.id }); c.state = 'idle'; status(); return; }
      if (!req.url.trim()) { HD.toast('Enter a ws:// or wss:// URL', 'warn'); return; }
      const { collection, chain } = context();
      c.state = 'connecting';
      status();
      HD.renderTabBar();
      try {
        const r = await window.api.ws.connect({
          id: tab.id, request: HD.clone(req), settings: { ...S.ws.settings, tunnelId: HD.tunnelIdFor(HD.activeEnvironment()) }, scopes: HD.scopesFor(collection),
          chain: chain.map((n) => ({ id: n.id, name: n.name, auth: n.auth })),
        });
        c.state = 'open';
        c.url = r.url;
        push(c, { kind: 'open', text: `Connected to ${r.url} in ${r.handshake.time} ms${r.handshake.protocol ? `, protocol ${r.handshake.protocol}` : ''} (click for handshake)`, handshake: r.handshake, url: r.url });
      } catch (e) {
        c.state = 'idle';
        push(c, { kind: 'error', text: `Could not connect: ${clean(e)}` });
      }
      status();
      HD.renderTabBar();
    };

    const sendMessage = async () => {
      const text = msgCm ? msgCm.getValue() : ui.wsDraft || '';
      if (c.state !== 'open') { HD.toast('Connect first', 'warn'); return; }
      if (!text) return;
      try {
        const r = await window.api.ws.send({ id: tab.id, text, scopes: HD.scopesFor(context().collection) });
        c.sent++;
        push(c, { dir: 'out', text: r.data, size: r.size });
      } catch (e) {
        push(c, { kind: 'error', text: `Could not send: ${clean(e)}` });
      }
    };

    const top = h('div.ws-top', header, urlBar, tabsHost, panel);
    root.append(h('div.ws-view', top, h('div.ws-log', logBar, logList)));
    HD.lineEditor(urlHost, {
      value: req.url, placeholder: 'wss://echo.example.com/socket',
      onEnter: () => toggle(),
      onChange: (v) => { req.url = v; markDirty(); HD.renderTabBar(); },
    });
    renderTabs();
    renderPanel();
    redraw();
    status();
  };
})();
