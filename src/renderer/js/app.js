'use strict';

/* App shell: top bar, tabs, console, theme, keyboard shortcuts and bootstrapping. */
(() => {
  const { h } = HD;
  const S = HD.S;

  // ---- Tabs ---------------------------------------------------------------------------------

  HD.currentTab = () => S.ws.tabs.find((t) => t.id === S.ws.activeTabId) || null;

  const activate = (id) => {
    S.ws.activeTabId = id;
    HD.save();
    HD.renderTabBar();
    HD.renderActiveTab();
    HD.renderSidebar();
  };
  HD.activateTab = activate;

  // ---- Preview tabs ---------------------------------------------------------------------------
  //
  // Clicking something in the sidebar opens it in a preview tab (its title in italics), which the
  // next thing clicked replaces, so looking around doesn't pile up tabs. A preview tab stays once
  // it's used: an edit, a send or a save, a double-click on the tab, or a double-click in the
  // sidebar. Opening any other way (search, buttons, AI) opens a tab that stays.

  /** Makes a preview tab stay. */
  HD.pinTab = (tab) => {
    if (!tab || !tab.preview) return;
    delete tab.preview;
    HD.save();
    HD.renderTabBar();
  };

  // ---- Undo and redo --------------------------------------------------------------------------
  //
  // Each request tab keeps the history of its draft (in memory only), so Ctrl/Cmd+Z brings back a
  // deleted header, a changed method or a switched version as well as typed text. Typing in one
  // field without a pause is one step. In the request's own fields and editors, undo goes to this
  // history, so everything undoes in one order; other fields (the sidebar search, a response
  // filter, dialogs) keep their own undo.

  const edits = new Map(); // tabId -> { past, future, current, clean, at, el }
  const snapDraft = (tab) => JSON.stringify({ name: tab.draft.name, request: tab.draft.request });

  const step = (e, now, el) => {
    const t = Date.now();
    if (!(el && el === e.el && t - e.at < 1000)) {
      e.past.push(e.current);
      const keep = Math.max(10, Math.min(200, Math.floor(20e6 / now.length))); // about 20 MB of steps
      while (e.past.length > keep) e.past.shift();
    }
    e.future = [];
    e.current = now;
    e.at = t;
    e.el = el;
  };

  /** Called when a request view renders: starts the tab's history, or notes a change made elsewhere. */
  HD.trackEdits = (tab) => {
    const now = snapDraft(tab);
    const e = edits.get(tab.id);
    // A saved tab replaced from outside (team sync, an AI edit) starts over.
    if (!e || (now !== e.current && !tab.dirty)) {
      edits.set(tab.id, { past: [], future: [], current: now, clean: tab.dirty ? null : now, at: 0, el: null });
      return;
    }
    if (now !== e.current) step(e, now, null); // such as a version switched to: undoable too
    if (!tab.dirty) e.clean = now;
  };

  /** Called after every edit of a request tab's draft. */
  HD.recordEdit = (tab) => {
    const e = edits.get(tab.id);
    if (!e) return;
    const now = snapDraft(tab);
    if (now !== e.current) step(e, now, document.activeElement);
  };

  /** Whether undo and redo at this element go to the current tab's history. */
  HD.ownsEdits = (el) => {
    const tab = HD.currentTab();
    if (!tab || tab.kind !== 'request' || !edits.has(tab.id)) return false;
    if (document.querySelector('.modal-overlay') || document.body.classList.contains('is-locked')) return false;
    if (!el || el === document.body) return true;
    if (el.closest('.own-undo')) return false;
    if (el.closest('.req-section, .ws-top')) return true;
    return !el.matches('input, textarea, [contenteditable]') && !el.closest('.CodeMirror');
  };

  // Where the cursor was, so it can be put back after the view is drawn again.
  const focusSpot = () => {
    const root = document.getElementById('content');
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const cm = a.closest('.CodeMirror');
    if (cm) return { cm: [...root.querySelectorAll('.CodeMirror')].indexOf(cm), cursor: cm.CodeMirror.getCursor() };
    if (a.matches('input, textarea')) return { field: [...root.querySelectorAll('input, textarea')].indexOf(a), pos: a.selectionStart };
    return null;
  };
  const refocus = (spot) => requestAnimationFrame(() => {
    if (!spot) return;
    const root = document.getElementById('content');
    if (spot.cm != null) {
      const el = root.querySelectorAll('.CodeMirror')[spot.cm];
      if (el) { el.CodeMirror.focus(); el.CodeMirror.setCursor(spot.cursor); }
      return;
    }
    const el = root.querySelectorAll('input, textarea')[spot.field];
    if (!el) return;
    el.focus();
    try { if (spot.pos != null) el.setSelectionRange(spot.pos, spot.pos); } catch { /* not a text field */ }
  });

  const restore = (tab, e, text) => {
    const s = JSON.parse(text);
    tab.draft.name = s.name;
    tab.draft.request = s.request;
    e.current = text;
    e.el = null;
    tab.dirty = text !== e.clean;
    const spot = focusSpot();
    HD.pinTab(tab);
    HD.save();
    HD.renderTabBar();
    HD.renderActiveTab();
    refocus(spot);
  };
  HD.undoEdit = (tab) => {
    const e = tab && edits.get(tab.id);
    if (!e || !e.past.length) return false;
    e.future.push(e.current);
    restore(tab, e, e.past.pop());
    return true;
  };
  HD.redoEdit = (tab) => {
    const e = tab && edits.get(tab.id);
    if (!e || !e.future.length) return false;
    e.past.push(e.current);
    restore(tab, e, e.future.pop());
    return true;
  };

  // What a closed tab leaves behind: a request in flight, a WebSocket, its response.
  const forget = (tab) => {
    edits.delete(tab.id);
    if (S.sending.get(tab.id)) window.api.cancel(tab.id);
    HD.closeWebSocketTab(tab.id);
    S.resRenderers.delete(tab.id);
    S.streamViews.delete(tab.id);
    S.responses.delete(tab.id);
  };

  /** Opens a tab after the current one; a preview takes the place of the last preview tab. */
  const addTab = (tab, { preview = false } = {}) => {
    if (preview) {
      tab.preview = true;
      const old = S.ws.tabs.find((t) => t.preview && !t.dirty && !S.sending.get(t.id));
      if (old) {
        const at = S.ws.tabs.indexOf(old);
        forget(old);
        S.ws.tabs.splice(at, 1, tab);
        activate(tab.id);
        return tab;
      }
    }
    const cur = HD.currentTab();
    const idx = cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length;
    S.ws.tabs.splice(idx, 0, tab);
    activate(tab.id);
    return tab;
  };
  HD.addTab = addTab;

  // An already open tab: shown, and kept when asked to.
  const reuse = (tab, { pin } = {}) => {
    if (pin) HD.pinTab(tab);
    activate(tab.id);
    return tab;
  };

  /** opts: { preview } opens it as a preview; { pin } keeps it (a double-click). */
  HD.openRequest = (itemId, opts = {}) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'request' && t.refId === itemId);
    if (existing) return reuse(existing, opts);
    const found = HD.find(itemId);
    if (!found) return null;
    return addTab({ id: HD.uid(), kind: 'request', refId: itemId, draft: { name: found.node.name, request: HD.clone(found.node.request) }, dirty: false, ui: {} }, opts);
  };

  HD.openNewRequest = (request, name, opts = {}) => {
    const def = HD.newRequestDef({ auth: { type: 'none' }, ...(request || {}) });
    // A URL with a query string fills the Params table, as typing it would.
    if (def.url && !(def.params && def.params.length) && !HD.isWebSocket(def)) HD.syncParamsFromUrl(def);
    // Where it will be saved, suggested: the folder (or collection) of what you were working in.
    const cur = HD.currentTab();
    const at = cur && cur.refId ? HD.find(cur.refId) : null;
    let saveTo = null;
    if (at && at.node.type === 'request') saveTo = { collectionId: at.collection.id, folderId: at.parents.length ? at.parents[at.parents.length - 1].id : null };
    else if (at && (at.node.type === 'folder' || at.node.type === 'collection')) saveTo = { collectionId: at.collection.id, folderId: at.node.type === 'folder' ? at.node.id : null };
    // A preview (of a history entry) isn't an unsaved change: history still has it.
    return addTab({ id: HD.uid(), kind: 'request', refId: null, draft: { name: name || 'Untitled Request', request: def }, dirty: !!request && !opts.preview, ui: {}, ...(saveTo ? { saveTo } : {}) }, opts);
  };

  HD.openContainer = (id, sub, opts = {}) => {
    const found = HD.find(id);
    if (!found) return;
    const existing = S.ws.tabs.find((t) => (t.kind === 'collection' || t.kind === 'folder') && t.refId === id);
    if (existing) {
      if (sub) existing.ui = { ...(existing.ui || {}), sub };
      return reuse(existing, opts);
    }
    return addTab({ id: HD.uid(), kind: found.node.type, refId: id, ui: sub ? { sub } : {} }, opts);
  };

  HD.openEnvironment = (id, opts = {}) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'environment' && t.refId === id);
    if (existing) return reuse(existing, opts);
    return addTab({ id: HD.uid(), kind: 'environment', refId: id }, opts);
  };
  HD.openGlobals = (opts = {}) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'globals');
    if (existing) return reuse(existing, opts);
    return addTab({ id: HD.uid(), kind: 'globals' }, opts);
  };
  HD.openRunner = (collectionId, folderId) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'runner');
    const cfg = { iterations: 1, delay: 0, persist: true, stopOnFailure: false, useCookies: true, environmentId: S.ws.activeEnvironmentId, excluded: {} };
    if (existing) {
      if (collectionId) existing.runner = { ...(existing.runner || cfg), collectionId, folderId: folderId || null, excluded: {} };
      return activate(existing.id);
    }
    return addTab({ id: HD.uid(), kind: 'runner', runner: { ...cfg, collectionId: collectionId || null, folderId: folderId || null } });
  };

  const tabTitle = HD.tabTitle = (t) => {
    if (t.kind === 'request') return t.draft.name || 'Untitled Request';
    if (t.kind === 'collection' || t.kind === 'folder') { const f = HD.find(t.refId); return f ? f.node.name : 'Deleted'; }
    if (t.kind === 'environment') { const e = S.ws.environments.find((x) => x.id === t.refId); return e ? e.name : 'Deleted'; }
    if (t.kind === 'globals') return 'Globals';
    if (t.kind === 'runner') return 'Collection Runner';
    if (t.kind === 'monitor') { const m = HD.monitors().find((x) => x.id === t.refId); return m ? m.name : 'Deleted'; }
    if (t.kind === 'flow') { const fl = HD.flows().find((x) => x.id === t.refId); return fl ? fl.name : 'Deleted'; }
    if (t.kind === 'secrets') return 'Secret scan';
    if (t.kind === 'audit') return 'Audit log';
    if (t.kind === 'team') { const r = HD.teamRepos().find((x) => x.id === t.refId); return r ? r.name : 'Disconnected'; }
    if (t.kind === 'discovery') { const d = HD.discoverySources().find((x) => x.id === t.refId); return d ? d.name : 'Deleted'; }
    return 'Tab';
  };

  HD.closeTab = async (id, force) => {
    const tab = S.ws.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!force && tab.dirty) {
      const choice = await new Promise((resolve) => {
        let done = false;
        HD.modal({
          title: 'Unsaved changes',
          body: h('p.confirm-text', `"${tabTitle(tab)}" has unsaved changes. Save them before closing?`),
          width: 440,
          buttons: [
            { label: 'Cancel', onClick: () => { done = true; resolve('cancel'); } },
            { label: "Don't save", danger: true, onClick: () => { done = true; resolve('discard'); } },
            { label: 'Save', primary: true, onClick: () => { done = true; resolve('save'); } },
          ],
          onClose: () => { if (!done) resolve('cancel'); },
        });
      });
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await HD.saveTab(tab))) return;
    }
    forget(tab);
    const idx = S.ws.tabs.indexOf(tab);
    S.ws.tabs.splice(idx, 1);
    if (S.ws.activeTabId === id) {
      const next = S.ws.tabs[idx] || S.ws.tabs[idx - 1];
      S.ws.activeTabId = next ? next.id : null;
    }
    HD.save();
    HD.renderTabBar();
    HD.renderActiveTab();
  };

  // Saves a request tab back to its collection (or asks where to save it). Returns true on success.
  HD.saveTab = async (tab) => {
    if (!tab || tab.kind !== 'request') return true;
    let found = HD.find(tab.refId);
    if (!found) {
      const loc = await HD.pickLocation('Save request', tab.draft.name, tab.saveTo);
      if (!loc) return false;
      const item = HD.newRequestItem(loc.name, HD.clone(tab.draft.request));
      const parent = HD.find(loc.folderId || loc.collectionId).node;
      parent.items.push(item);
      (S.ws.ui.expanded = S.ws.ui.expanded || {})[parent.id] = true;
      tab.refId = item.id;
      delete tab.saveTo;
      tab.draft.name = loc.name;
      found = HD.find(item.id);
    } else {
      found.node.request = HD.clone(tab.draft.request);
      found.node.name = tab.draft.name;
    }
    tab.dirty = false;
    delete tab.preview;
    HD.save();
    HD.renderSidebar();
    HD.renderTabBar();
    if (HD.currentTab() === tab) HD.renderActiveTab();
    HD.toast('Saved', 'success', 1200);
    return true;
  };

  HD.renderTabBar = () => {
    const bar = document.getElementById('tabbar');
    HD.clear(bar);
    const strip = h('div.tabs');
    for (const t of S.ws.tabs) {
      const icon = t.kind === 'request'
        ? h(`span.method-tag.${HD.methodClass(t.draft.request.method)}`, t.draft.request.method.slice(0, 6))
        : HD.icon({ collection: 'layers', folder: 'folder', environment: 'globe', globals: 'globe', runner: 'play', discovery: 'search', monitor: 'pulse', flow: 'flow', secrets: 'shield', audit: 'history', team: 'users' }[t.kind] || 'file');
      const el = h('div.tab', {
        class: [t.id === S.ws.activeTabId && 'active', t.dirty && 'dirty', S.sending.get(t.id) && 'sending', t.preview && 'preview'].filter(Boolean).join(' '),
        title: `${t.kind === 'request' ? `${tabTitle(t)}\n${t.draft.request.url}` : tabTitle(t)}${t.preview ? '\nPreview: the next item you open replaces it. Double-click to keep it.' : ''}`,
        draggable: 'true',
        onclick: () => activate(t.id),
        ondblclick: () => HD.pinTab(t),
        onauxclick: (e) => { if (e.button === 1) HD.closeTab(t.id); },
        oncontextmenu: (e) => HD.menu(e, [
          { label: 'Close', onClick: () => HD.closeTab(t.id) },
          { label: 'Close other tabs', onClick: async () => { for (const o of S.ws.tabs.filter((x) => x.id !== t.id)) await HD.closeTab(o.id); } },
          { label: 'Close all tabs', onClick: async () => { for (const o of [...S.ws.tabs]) await HD.closeTab(o.id); } },
          t.preview ? { label: 'Keep open', onClick: () => HD.pinTab(t) } : null,
          t.kind === 'request' ? { label: 'Duplicate tab', onClick: () => HD.openNewRequest(HD.clone(t.draft.request), `${t.draft.name} Copy`) } : null,
        ]),
        ondragstart: (e) => { e.dataTransfer.setData('text/tab', t.id); },
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/tab')) e.preventDefault(); },
        ondrop: (e) => {
          const from = e.dataTransfer.getData('text/tab');
          if (!from || from === t.id) return;
          e.preventDefault();
          e.stopPropagation();
          const src = S.ws.tabs.find((x) => x.id === from);
          S.ws.tabs.splice(S.ws.tabs.indexOf(src), 1);
          S.ws.tabs.splice(S.ws.tabs.indexOf(t), 0, src);
          HD.save();
          HD.renderTabBar();
        },
      }, icon, h('span.tab-title', tabTitle(t)),
      h('button.tab-close', { type: 'button', title: 'Close tab', onclick: (e) => { e.stopPropagation(); HD.closeTab(t.id); } }, h('span.tab-dot'), HD.icon('x')));
      strip.appendChild(el);
    }
    bar.append(strip, HD.button('', () => HD.openNewRequest(), { icon: 'plus', ghost: true, title: 'New request (Ctrl+T)', class: 'tab-add' }));
    const active = bar.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  HD.renderActiveTab = () => {
    const root = document.getElementById('content');
    HD.clear(root);
    const tab = HD.currentTab();
    if (!tab) {
      HD.variableInfo = () => HD.variableInfoFor(null);
      root.appendChild(h('div.welcome',
        h('div.welcome-title', 'HttpDash'),
        h('div.muted', 'Build, test and document HTTP APIs.'),
        h('div.welcome-actions',
          HD.button('New request', () => HD.openNewRequest(), { primary: true, icon: 'plus' }),
          HD.button('Import', () => HD.showImport(), { icon: 'download' }),
          HD.button('Collection runner', () => HD.openRunner(), { icon: 'play' })),
        h('div.welcome-tips',
          h('div', h('kbd', 'Ctrl/Cmd + T'), ' new request'),
          h('div', h('kbd', 'Ctrl/Cmd + Enter'), ' send'),
          h('div', h('kbd', 'Ctrl/Cmd + S'), ' save'),
          h('div', 'Paste a cURL command into the URL bar to import it'))));
      return;
    }
    const view = HD.views[tab.kind];
    if (view) view(tab, root);
  };

  // ---- Top bar ------------------------------------------------------------------------------

  // An environment can have a color: the top bar and the status bar take a faint tint of the active
  // one's, so it's clear at a glance which environment requests go to (red for production, say).
  HD.ENV_COLORS = [['', 'None'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['gray', 'Gray']];
  HD.applyEnvColor = () => {
    const env = HD.activeEnvironment();
    const color = env && env.color && HD.ENV_COLORS.some(([c]) => c === env.color) ? env.color : '';
    if (color) document.documentElement.dataset.envColor = color;
    else delete document.documentElement.dataset.envColor;
  };
  HD.envDot = (env) => (env && env.color ? h(`span.env-dot.env-${env.color}`, { title: `${env.name}: ${env.color}` }) : null);

  HD.renderEnvSelect = () => {
    const host = document.getElementById('env-select');
    HD.clear(host);
    HD.applyEnvColor();
    const dot = HD.envDot(HD.activeEnvironment());
    if (dot) host.appendChild(dot);
    host.appendChild(HD.select([['', 'No Environment'], ...S.ws.environments.map((e) => [e.id, e.name])], S.ws.activeEnvironmentId || '', (v) => {
      S.ws.activeEnvironmentId = v || null;
      HD.save();
      HD.renderSidebar();
      HD.refreshVarHighlights();
      const t = HD.currentTab();
      if (t && t.kind === 'environment') HD.renderActiveTab();
    }, 'env-dropdown'));
    const eye = HD.button('', () => HD.showQuickLook(eye), { icon: 'eye', ghost: true, title: 'Environment quick look' });
    host.appendChild(eye);
  };

  const renderTopbar = () => {
    const bar = document.getElementById('topbar');
    HD.clear(bar);
    bar.append(
      h('div.brand', h('span.brand-mark', 'H'), h('span', 'HttpDash')),
      HD.button('New', (e) => HD.menu(e, [
        { label: 'HTTP Request', hint: 'Ctrl+T', onClick: () => HD.openNewRequest() },
        { label: 'WebSocket Request', onClick: () => HD.openNewWebSocket() },
        { label: 'Collection', onClick: async () => { const n = await HD.prompt('New collection', 'Name', 'New Collection'); if (n) { const c = HD.newCollection(n); S.ws.collections.push(c); HD.save(); S.ws.ui.sidebarTab = 'collections'; HD.renderSidebar(); HD.openContainer(c.id); } } },
        { label: 'Environment', onClick: async () => { const n = await HD.prompt('New environment', 'Name', 'New Environment'); if (n) { const env = HD.newEnvironment(n); S.ws.environments.push(env); HD.save(); HD.renderEnvSelect(); S.ws.ui.sidebarTab = 'environments'; HD.renderSidebar(); HD.openEnvironment(env.id); } } },
      ]), { icon: 'plus', small: true }),
      HD.button('Import', () => HD.showImport(), { icon: 'download', small: true }),
      HD.button('Export', () => HD.showExportAll(), { icon: 'upload', small: true }),
      HD.button('Runner', () => HD.openRunner(), { icon: 'play', small: true, ghost: true }),
      h('span.spacer'),
      h('div#env-select'),
      h('div#lock-button'),
      HD.button('', () => HD.showCookies(), { icon: 'cookie', ghost: true, title: 'Cookies' }),
      HD.button('', () => HD.showSettings(), { icon: 'gear', ghost: true, title: 'Settings' }));
    HD.renderEnvSelect();
  };

  // ---- Console & status bar ----------------------------------------------------------------

  let consoleFilter = 'all';
  const renderConsole = () => {
    const panel = document.getElementById('console');
    const open = !!S.ws.ui.consoleOpen;
    panel.classList.toggle('open', open);
    if (S.ws.ui.consoleHeight) panel.style.height = `${S.ws.ui.consoleHeight}px`;
    HD.clear(panel);
    if (!open) return;
    const levels = { all: () => true, net: (l) => l.level === 'net', log: (l) => l.level !== 'net', error: (l) => l.level === 'error' || l.level === 'warn' };
    const resize = h('div.console-resize');
    const list = h('div.console-list');
    panel.append(resize,
      h('div.console-head', h('b', 'Console'),
        HD.tabStrip([{ id: 'all', label: 'All' }, { id: 'net', label: 'Network' }, { id: 'log', label: 'Logs' }, { id: 'error', label: 'Errors' }], consoleFilter, (id) => { consoleFilter = id; renderConsole(); }, 'segmented'),
        h('span.spacer'),
        HD.button('Clear', () => { S.consoleLogs.length = 0; renderConsole(); }, { small: true, ghost: true }),
        HD.button('', () => { S.ws.ui.consoleOpen = false; HD.save(); renderConsole(); renderStatusbar(); }, { icon: 'x', ghost: true, small: true, title: 'Close console' })),
      list);
    const logs = S.consoleLogs.filter(levels[consoleFilter]);
    if (!logs.length) list.appendChild(h('div.muted.small.panel-pad', 'Network activity and console.log() output from scripts appear here.'));
    for (const l of logs) {
      list.appendChild(h(`div.console-line.lvl-${l.level}`,
        h('span.console-time', new Date(l.time).toLocaleTimeString()),
        h('span.console-level', l.level.toUpperCase()),
        h('span.console-msg', l.message),
        l.extra && l.extra.request ? h('span.console-src', l.extra.request) : null));
    }
    list.scrollTop = list.scrollHeight;
    let startH;
    resize.addEventListener('mousedown', () => { startH = panel.offsetHeight; });
    HD.splitter(resize, { axis: 'y', onMove: (d) => { const v = Math.max(80, Math.min(window.innerHeight - 200, startH - d)); panel.style.height = `${v}px`; S.ws.ui.consoleHeight = v; }, onEnd: () => HD.save() });
  };
  HD.on('console', HD.debounce(() => { renderConsole(); renderStatusbar(); }, 50));

  const renderStatusbar = () => {
    const bar = document.getElementById('statusbar');
    HD.clear(bar);
    const errors = S.consoleLogs.filter((l) => l.level === 'error').length;
    bar.append(
      HD.button('', () => { S.ws.ui.sidebarHidden = !S.ws.ui.sidebarHidden; HD.save(); applyLayout(); }, { icon: 'sidebar', ghost: true, small: true, title: 'Toggle sidebar (Ctrl+\\)' }),
      HD.button(errors ? `Console (${errors} errors)` : 'Console', () => { S.ws.ui.consoleOpen = !S.ws.ui.consoleOpen; HD.save(); renderConsole(); renderStatusbar(); }, { icon: 'terminal', ghost: true, small: true, class: errors ? 'has-errors' : '' }),
      h('span.spacer'),
      HD.aiIndicator ? HD.aiIndicator() : null,
      (HD.tunnelIndicator && HD.tunnelIndicator()) || '',
      HD.button('Cookies', () => HD.showCookies(), { icon: 'cookie', ghost: true, small: true }),
      HD.button('Runner', () => HD.openRunner(), { icon: 'play', ghost: true, small: true }),
      HD.button('', () => { S.ws.ui.layout = (S.ws.ui.layout || 'vertical') === 'vertical' ? 'horizontal' : 'vertical'; HD.save(); HD.renderActiveTab(); }, { icon: (S.ws.ui.layout || 'vertical') === 'vertical' ? 'columns' : 'rows', ghost: true, small: true, title: 'Toggle request/response layout' }));
  };

  HD.on('tunnels', () => renderStatusbar());

  // The rail takes about 95px of the sidebar; below 300 the list's search box is too short to read.
  const SIDEBAR_MIN = 300, SIDEBAR_MAX = 600;
  const applyLayout = () => {
    const side = document.getElementById('sidebar-wrap');
    side.style.display = S.ws.ui.sidebarHidden ? 'none' : '';
    side.style.width = `${Math.max(SIDEBAR_MIN, S.ws.ui.sidebarWidth || SIDEBAR_MIN)}px`;
  };
  HD.applyLayout = applyLayout;

  // ---- Theme --------------------------------------------------------------------------------

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  HD.applyTheme = () => {
    const pref = S.ws.settings.theme || 'system';
    const theme = pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--editor-font-size', `${S.ws.settings.fontSize || 13}px`);
    applyZoom();
    document.querySelectorAll('.CodeMirror').forEach((c) => c.CodeMirror && c.CodeMirror.refresh());
  };
  darkQuery.addEventListener('change', () => HD.applyTheme());

  // Zoom: 70% to 130% in steps of 10, kept in the settings so it comes back at the next start
  // (a value outside the steps reads as 100). Settings shows it with − and +, and Ctrl/Cmd + = − 0
  // (and the View menu) move the same value.
  HD.ZOOM_STEPS = [70, 80, 90, 100, 110, 120, 130];
  HD.zoom = () => (HD.ZOOM_STEPS.includes(S.ws.settings.zoom) ? S.ws.settings.zoom : 100);
  const applyZoom = () => {
    const z = HD.zoom();
    if (window.api.setZoom) window.api.setZoom(z / 100);
    // A Settings dialog that is open follows a change made from the keyboard or the menu.
    document.querySelectorAll('.zoom-value').forEach((el) => { el.textContent = `${z}%`; });
    document.querySelectorAll('.zoom-out').forEach((el) => { el.disabled = z === HD.ZOOM_STEPS[0]; });
    document.querySelectorAll('.zoom-in').forEach((el) => { el.disabled = z === HD.ZOOM_STEPS[HD.ZOOM_STEPS.length - 1]; });
    document.querySelectorAll('.zoom-reset').forEach((el) => { el.disabled = z === 100; });
  };
  HD.setZoom = (step) => {
    const i = HD.ZOOM_STEPS.indexOf(HD.zoom());
    const z = step === 0 ? 100 : HD.ZOOM_STEPS[Math.max(0, Math.min(HD.ZOOM_STEPS.length - 1, i + step))];
    if (z === HD.zoom() && S.ws.settings.zoom === z) return;
    S.ws.settings.zoom = z;
    HD.save();
    applyZoom();
  };

  // ---- Commands -----------------------------------------------------------------------------

  const commands = {
    'new-request': () => HD.openNewRequest(),
    'new-collection': async () => { const n = await HD.prompt('New collection', 'Name', 'New Collection'); if (n) { const c = HD.newCollection(n); S.ws.collections.push(c); HD.save(); HD.renderSidebar(); HD.openContainer(c.id); } },
    'new-environment': async () => { const n = await HD.prompt('New environment', 'Name', 'New Environment'); if (n) { const e = HD.newEnvironment(n); S.ws.environments.push(e); HD.save(); HD.renderEnvSelect(); HD.renderSidebar(); HD.openEnvironment(e.id); } },
    import: () => HD.showImport(),
    save: () => HD.saveTab(HD.currentTab()),
    'close-tab': () => { const t = HD.currentTab(); if (t) HD.closeTab(t.id); },
    settings: () => HD.showSettings(),
    'toggle-sidebar': () => { S.ws.ui.sidebarHidden = !S.ws.ui.sidebarHidden; HD.save(); applyLayout(); },
    'toggle-console': () => { S.ws.ui.consoleOpen = !S.ws.ui.consoleOpen; HD.save(); renderConsole(); renderStatusbar(); },
    send: () => { const t = HD.currentTab(); const fn = t && S.senders.get(t.id); if (fn) fn(); },
    runner: () => HD.openRunner(),
    cookies: () => HD.showCookies(),
    codegen: () => HD.showCodegen(HD.currentTab()),
    lock: () => HD.lockNow(),
    secrets: () => HD.openSecretScan(),
    audit: () => HD.openAuditLog(),
    monitors: () => { S.ws.ui.sidebarTab = 'monitors'; HD.save(); HD.renderSidebar(); },
    team: () => { S.ws.ui.sidebarTab = 'team'; HD.save(); HD.renderSidebar(); if (!HD.teamRepos().length) HD.newTeamRepo(); },
    'team-sync': () => HD.teamRepos().forEach((r) => HD.teamSync(r)),
    // Find: the response body (or the page's filter); with nothing to search there, the requests.
    find: () => {
      const root = document.getElementById('content');
      const body = root.querySelector('.res-pane .CodeMirror');
      if (body) { body.CodeMirror.focus(); body.CodeMirror.execCommand('findPersistent'); return; }
      const filter = root.querySelector('.res-pane .jt-filter, .ws-filter, .runner-filter input, .side-search');
      if (filter) { filter.focus(); filter.select(); return; }
      commands['search-requests']();
    },
    'search-requests': () => {
      S.ws.ui.sidebarHidden = false;
      applyLayout();
      if ((S.ws.ui.sidebarTab || 'collections') !== 'collections') { S.ws.ui.sidebarTab = 'collections'; HD.renderSidebar(); }
      HD.save();
      const input = document.querySelector('#sidebar .side-search-box input');
      if (input) { input.focus(); input.select(); }
    },
    'zoom-in': () => HD.setZoom(1),
    'zoom-out': () => HD.setZoom(-1),
    'zoom-reset': () => HD.setZoom(0),
    'next-tab': () => cycleTab(1),
    'prev-tab': () => cycleTab(-1),
    undo: () => HD.undoEdit(HD.currentTab()),
    redo: () => HD.redoEdit(HD.currentTab()),
  };
  const cycleTab = (d) => {
    const tabs = S.ws.tabs;
    if (tabs.length < 2) return;
    const i = tabs.indexOf(HD.currentTab());
    activate(tabs[(i + d + tabs.length) % tabs.length].id);
  };
  // Ctrl/Cmd+1 to 8 open that tab, 9 the last one.
  for (let n = 1; n <= 9; n++) commands[`tab-${n}`] = () => { const t = n === 9 ? S.ws.tabs[S.ws.tabs.length - 1] : S.ws.tabs[n - 1]; if (t) activate(t.id); };
  HD.command = (name) => commands[name] && commands[name]();
  // Keyboard shortcuts are handled here; the application menu only displays them. A shortcut an
  // editor already handled (Find in a code editor, say) is left to it.
  const SHORTCUTS = { t: 'new-request', o: 'import', s: 'save', w: 'close-tab', f: 'find', ',': 'settings', '\\': 'toggle-sidebar', Enter: 'send', l: 'lock', Tab: 'next-tab', PageDown: 'next-tab', PageUp: 'prev-tab' };
  const SHIFT_SHORTCUTS = { f: 'search-requests', Tab: 'prev-tab', BracketRight: 'next-tab', BracketLeft: 'prev-tab' };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!e.altKey && (key === 'z' || (key === 'y' && !e.shiftKey))) {
      // Undo and redo in a request tab go to its history; elsewhere the field undoes its own typing.
      if (!HD.ownsEdits(document.activeElement)) return;
      e.preventDefault();
      HD.command(key === 'y' || e.shiftKey ? 'redo' : 'undo');
      return;
    }
    // Zoom works over a dialog too, so Settings shows the change as it happens. Ctrl/Cmd+= and +
    // (with or without Shift, or on the keypad) zoom in.
    if (!e.altKey && (key === '=' || key === '+' || key === '-' || key === '_' || (key === '0' && !e.shiftKey))) {
      if (document.body.classList.contains('is-locked')) return;
      e.preventDefault();
      HD.command(key === '0' ? 'zoom-reset' : key === '-' || key === '_' ? 'zoom-out' : 'zoom-in');
      return;
    }
    let cmd;
    if (e.altKey) cmd = !e.shiftKey && (key === 'c' || e.code === 'KeyC') ? 'toggle-console' : null;
    else if (e.shiftKey) cmd = SHIFT_SHORTCUTS[key] || SHIFT_SHORTCUTS[e.code];
    else cmd = /^[1-9]$/.test(key) ? `tab-${key}` : SHORTCUTS[key];
    if (!cmd) return;
    if (document.querySelector('.modal-overlay') || document.body.classList.contains('is-locked')) return;
    e.preventDefault();
    HD.command(cmd);
  });
  window.api.onMenu((cmd) => {
    // Don't fire app shortcuts while a modal dialog is open.
    if (document.body.classList.contains('is-locked')) return;
    if (document.querySelector('.modal-overlay') && cmd !== 'close-tab' && !cmd.startsWith('zoom-')) return;
    HD.command(cmd);
  });

  // ---- Boot ---------------------------------------------------------------------------------

  const boot = async () => {
    // With the app lock on, nothing is loaded until an LDAP sign-in succeeds.
    const lockStatus = await window.api.lock.status();
    HD.lockState = lockStatus;
    if (lockStatus.locked) {
      HD.showLockScreen(lockStatus);
      return;
    }
    await HD.load();
    HD.applyTheme();
    // Clean up tabs that refer to things that no longer exist.
    S.ws.tabs = S.ws.tabs.filter((t) => t.kind !== 'request' || t.draft);
    if (S.ws.activeTabId && !S.ws.tabs.some((t) => t.id === S.ws.activeTabId)) S.ws.activeTabId = S.ws.tabs[0] ? S.ws.tabs[0].id : null;
    renderTopbar();
    applyLayout();
    HD.renderSidebar();
    HD.renderTabBar();
    HD.renderActiveTab();
    renderConsole();
    renderStatusbar();
    if (HD.aiConfigure) HD.aiConfigure();

    const handle = document.getElementById('sidebar-resize');
    let startW;
    handle.addEventListener('mousedown', () => { startW = document.getElementById('sidebar-wrap').offsetWidth; });
    HD.splitter(handle, {
      axis: 'x',
      onMove: (d) => { S.ws.ui.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + d)); applyLayout(); },
      onEnd: () => { HD.save(); document.querySelectorAll('.CodeMirror').forEach((c) => c.CodeMirror && c.CodeMirror.refresh()); },
    });
    HD.on('variables', () => {
      HD.refreshVarHighlights();
      const t = HD.currentTab();
      if (t && ['environment', 'globals', 'collection'].includes(t.kind)) HD.renderActiveTab();
    });
    window.addEventListener('beforeunload', () => { window.api.saveWorkspace(S.ws).catch(() => {}); });
    HD.renderTopbarLock();
    HD.startIdleLock();
    HD.startMonitors();
    try {
      if (sessionStorage.getItem('hd-recovered')) {
        sessionStorage.removeItem('hd-recovered');
        HD.toast('Unlocked with the recovery code. The lock is now off; fix the LDAP settings and turn it on again.', 'warn', 9000);
        HD.showSettings('security');
      }
    } catch { /* storage unavailable */ }
    HD.syncDiscoveryOnStartup();
  };
  boot().catch((e) => {
    document.body.textContent = `Failed to start: ${e.message}`;
    console.error(e);
  });
})();
