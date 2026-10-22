'use strict';

/* Sidebar: collections tree, environments list and history. */
(() => {
  const { h } = HD;
  const S = HD.S;
  let filter = '';
  let dragId = null;

  const expanded = () => (S.ws.ui.expanded = S.ws.ui.expanded || {});

  HD.renderSidebar = () => {
    if (HD.applyEnvColor) HD.applyEnvColor();
    const root = document.getElementById('sidebar');
    HD.clear(root);
    const tab = S.ws.ui.sidebarTab || 'collections';
    const nav = h('div.side-nav', [
      ['collections', 'layers', 'Collections'],
      ['environments', 'globe', 'Environments'],
      ['history', 'history', 'History'],
      ['monitors', 'pulse', 'Monitors'],
      ['team', 'users', 'Team'],
    ].map(([id, icon, label]) => h('button.side-nav-btn', {
      class: id === tab ? 'active' : '', type: 'button', title: label,
      onclick: () => { S.ws.ui.sidebarTab = id; HD.save(); HD.renderSidebar(); },
    }, HD.icon(icon), h('span', label))));
    const panel = h('div.side-panel');
    root.append(nav, panel);
    if (tab === 'collections') renderCollections(panel);
    else if (tab === 'environments') renderEnvironments(panel);
    else if (tab === 'monitors') HD.renderMonitorsSidebar(panel);
    else if (tab === 'team') HD.renderTeamSidebar(panel);
    else renderHistory(panel);
  };

  // Shows which items are shared through a team repository.
  const teamBadge = (item) => {
    if (!item.team) return null;
    const repo = HD.teamRepos().find((r) => r.id === item.team);
    return h('span.team-badge', { title: `Shared through "${repo ? repo.name : 'a team repository'}"` }, HD.icon('users'));
  };

  const toolbar = (onAdd, addTitle, extra) => {
    const search = h('input.input.side-search', {
      placeholder: 'Filter', value: filter, spellcheck: 'false',
      oninput: HD.debounce((e) => { filter = e.target.value; const pos = e.target.selectionStart; HD.renderSidebar(); const s = document.querySelector('.side-search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }, 150),
    });
    return h('div.side-toolbar', onAdd ? HD.button('', onAdd, { icon: 'plus', ghost: true, title: addTitle }) : null, search, extra || null);
  };

  // ---- Collections --------------------------------------------------------------------------

  // The collections search: chips (tags, methods, URLs, names) and typed text. Typed text also finds
  // the requests in a folder or collection by its name. A folder is shown when something inside it
  // matches, or, for plain text, when its own name does. When typed text matches nothing exactly,
  // close matches (one typo away) are shown instead, with a note saying so.
  const query = { tokens: [], text: '' };
  let fuzzy = false;
  const matches = (node, path = []) => {
    if (!HD.queryActive(query)) return true;
    if (node.type === 'request') return HD.matchRequest(HD.liveItem(node), query, { path, fuzzy }) || HD.matchingVersions(node, query).length > 0;
    const text = query.text.trim().toLowerCase();
    if (!query.tokens.length && text && node.name.toLowerCase().includes(text)) return true;
    return (node.items || []).some((c) => matches(c, [...path, node.name]));
  };
  // A tag clicked on a request (or in the tree) is added to the search, which is shown if it was hidden.
  HD.filterByTag = (tag) => {
    if (!query.tokens.some((t) => t.kind === 'tag' && t.value.toLowerCase() === String(tag).toLowerCase())) query.tokens.push({ kind: 'tag', value: tag });
    S.ws.ui.sidebarTab = 'collections';
    if (S.ws.ui.sidebarHidden) { S.ws.ui.sidebarHidden = false; HD.applyLayout(); }
    HD.rememberSearch('sidebar', query);
    HD.save();
    HD.renderSidebar();
  };
  const tagButton = (tag, label = tag) => h('span.tree-tag.clickable', {
    role: 'button', title: `Show requests tagged #${tag}`,
    onclick: (e) => { e.stopPropagation(); HD.filterByTag(tag); },
  }, label);
  // The tags of a request in the tree: one shown, the one the search matched if any, the rest as "+n".
  const treeTags = (tags, terms) => {
    const wanted = new Set(query.tokens.filter((t) => t.kind === 'tag').map((t) => t.value.toLowerCase()));
    const hit = (t) => wanted.has(t.toLowerCase()) || HD.highlightRanges(t, terms, fuzzy).length > 0;
    const first = tags.find(hit) || tags[0];
    return h('span.tree-tags', { title: tags.map((t) => `#${t}`).join(' ') },
      tagButton(first, HD.highlight(first, terms, fuzzy)), tags.length > 1 ? h('span.tree-tag.more', `+${tags.length - 1}`) : null);
  };
  const unsavedMatches = () => HD.unsavedTabItems().filter((it) => HD.matchRequest(it, query, { fuzzy }));
  // Exact matches first; only when there are none does a typo count.
  const chooseFuzzy = () => {
    fuzzy = false;
    if (!HD.queryHasText(query) || S.ws.collections.some((c) => matches(c)) || unsavedMatches().length) return;
    fuzzy = true;
    if (!S.ws.collections.some((c) => matches(c)) && !unsavedMatches().length) fuzzy = false;
  };

  function renderCollections(panel) {
    const search = HD.searchBox({ query, onChange: () => drawTree(), className: 'side-search-box', historyKey: 'sidebar' });
    panel.appendChild(h('div.side-toolbar',
      HD.button('', async () => {
        const name = await HD.prompt('New collection', 'Name', 'New Collection');
        if (!name) return;
        const c = HD.newCollection(name);
        S.ws.collections.push(c);
        expanded()[c.id] = true;
        HD.save();
        HD.renderSidebar();
        HD.openContainer(c.id);
      }, { icon: 'plus', ghost: true, title: 'New collection' }),
      search,
      HD.button('', () => HD.showImport(), { icon: 'download', ghost: true, title: 'Import' })));
    const tree = h('div.tree');
    panel.appendChild(tree);
    // Only the tree is drawn again as the search changes, so the search box keeps its focus and menu.
    const drawTree = () => {
    HD.clear(tree);
    const f = HD.queryActive(query);
    if (f) chooseFuzzy(); else fuzzy = false;
    // What the search matched is highlighted in names and tags.
    const terms = f ? HD.searchTerms(query) : [];
    if (fuzzy) {
      const typed = [...query.tokens.filter((t) => t.kind === 'text').map((t) => t.value), query.text.trim()].filter(Boolean).join(' ');
      tree.appendChild(h('div.search-note', `No exact match for “${typed}”. Showing close matches.`));
    }
    if (!S.ws.collections.length) {
      tree.appendChild(h('div.empty-state.small', h('div', 'No collections yet.'), h('div.muted', 'Create one, or import a Postman collection / OpenAPI file.')));
    }
    const active = HD.currentTab();
    const activeRef = active && active.refId;
    let shown = 0;
    const renderNode = (node, depth, collection, path = []) => {
      if (!matches(node, path)) return;
      if (node.type === 'request') shown++;
      const isContainer = node.type !== 'request';
      const open = f ? true : !!expanded()[node.id];
      const row = h('div.tree-row', {
        class: [activeRef === node.id && 'active', isContainer && 'container'].filter(Boolean).join(' '),
        style: { paddingLeft: `${6 + depth * 14}px` },
        draggable: node.type !== 'collection' ? 'true' : null,
        dataset: { id: node.id },
        onclick: () => {
          if (isContainer) { expanded()[node.id] = !expanded()[node.id]; HD.save(); HD.renderSidebar(); } else HD.openRequest(node.id, { preview: true });
        },
        // A double-click keeps the tab (a single click opens a preview).
        ondblclick: () => { if (isContainer) HD.openContainer(node.id, undefined, { pin: true }); else HD.openRequest(node.id, { pin: true }); },
        oncontextmenu: (e) => HD.menu(e, nodeMenu(node, collection)),
        ondragstart: (e) => {
          dragId = node.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-httpdash-node', node.id);
          row.classList.add('drag-source');
        },
        ondragend: () => { dragId = null; clearDrop(); document.querySelectorAll('.tree-row.drag-source').forEach((r) => r.classList.remove('drag-source')); },
        ondragover: (e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const pos = dropPosition(e, row, node);
          if (row.dataset.drop !== pos) {
            clearDrop();
            row.dataset.drop = pos;
            row.classList.add(`drop-${pos}`);
            // The line starts where the item will be indented: at this row's level.
            row.style.setProperty("--drop-left", `${28 + depth * 14}px`);
          }
          // Hold over a closed folder to open it.
          if (pos === 'into' && isContainer && !open && !row.dataset.opening) {
            row.dataset.opening = '1';
            clearTimeout(openTimer);
            openTimer = setTimeout(() => { if (row.dataset.drop === 'into') { expanded()[node.id] = true; HD.renderSidebar(); } }, 650);
          }
        },
        ondragleave: (e) => { if (!row.contains(e.relatedTarget)) { row.classList.remove('drop-into', 'drop-before', 'drop-after'); delete row.dataset.drop; delete row.dataset.opening; } },
        ondrop: (e) => {
          e.preventDefault();
          e.stopPropagation();
          const pos = row.dataset.drop || dropPosition(e, row, node);
          clearDrop();
          moveNode(dragId, node, pos);
          dragId = null;
        },
      },
      isContainer ? h('span.tree-caret', { class: open ? 'open' : '' }, HD.icon('chevron')) : h('span.tree-caret.empty'),
      node.type === 'request' ? h(`span.method-tag.${HD.methodClass(node.request.method)}`, node.request.method.slice(0, 6)) : HD.icon(node.type === 'collection' ? 'layers' : 'folder'),
      h('span.tree-name', HD.highlight(node.name, terms, fuzzy)),
      node.type === 'request' && node.request.tags && node.request.tags.length ? treeTags(node.request.tags, terms) : null,
      teamBadge(node),
      h('button.tree-more', { type: 'button', title: 'More actions', onclick: (e) => { e.stopPropagation(); HD.menu(e, nodeMenu(node, collection)); } }, HD.icon('dots')));
      tree.appendChild(row);
      // Versions of the request that match the search, under it: clicking one opens the request with it.
      if (node.type === 'request' && f) {
        for (const v of HD.matchingVersions(node, query)) {
          tree.appendChild(h('div.tree-row.tree-version', {
            style: { paddingLeft: `${30 + depth * 14}px` }, title: 'Open the request with this version',
            onclick: () => { HD.openRequest(node.id); const t = HD.currentTab(); if (t) HD.useVersion(t, v); },
          }, HD.icon('history'), h('span.tree-name', HD.highlight(v.name || HD.versionLabel(v), terms)),
          (v.tags || []).length ? h('span.tree-tags', h('span.tree-tag', v.tags[0]), v.tags.length > 1 ? h('span.tree-tag.more', `+${v.tags.length - 1}`) : null) : null,
          v.response && v.response.status ? h(`span.small.${HD.statusClass(v.response.status)}`, String(v.response.status)) : null));
        }
      }
      if (isContainer && open) {
        if (!node.items.length && !f) tree.appendChild(h('div.tree-empty', { style: { paddingLeft: `${34 + depth * 14}px` } }, 'Empty — ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); addRequest(node); } }, 'add a request')));
        node.items.forEach((c) => renderNode(c, depth + 1, collection, [...path, node.name]));
      }
    };
    S.ws.collections.forEach((c) => renderNode(c, 0, c));
    // Open tabs that aren't saved yet match too, so what was just typed in one is found.
    const unsaved = f ? unsavedMatches() : [];
    if (unsaved.length) {
      shown = true;
      tree.appendChild(h('div.side-section.tree-unsaved', h('span.section-title.flush', 'Open tabs, not saved')));
      for (const it of unsaved) {
        tree.appendChild(h('div.tree-row', { class: S.ws.activeTabId === it.tabId ? 'active' : '', style: { paddingLeft: '20px' }, title: 'Not saved yet: Ctrl+S keeps it in a collection', onclick: () => HD.activateTab(it.tabId) },
          h(`span.method-tag.${HD.methodClass(it.request.method)}`, String(it.request.method).slice(0, 6)),
          h('span.tree-name', HD.highlight(it.name, terms, fuzzy)),
          (it.request.tags || []).length ? h('span.tree-tags', it.request.tags.slice(0, 3).map((t) => h('span.tree-tag', '#', HD.highlight(t, terms, fuzzy)))) : null));
      }
    }
    if (f && !shown && S.ws.collections.length) tree.appendChild(h('div.empty-state.small', h('div', 'No request matches.'), h('div.muted', 'Remove a filter, or press Esc to clear the text.')));
    };
    drawTree();
  }

  const addRequest = (parent, def) => {
    const r = def ? HD.newRequestItem('New WebSocket', def) : HD.newRequestItem();
    parent.items.push(r);
    expanded()[parent.id] = true;
    HD.save();
    HD.renderSidebar();
    HD.openRequest(r.id);
  };

  function nodeMenu(node, collection) {
    const found = HD.find(node.id);
    const rename = async () => {
      const name = await HD.prompt('Rename', 'Name', node.name);
      if (!name) return;
      node.name = name;
      for (const t of S.ws.tabs) {
        if (t.refId === node.id) { t.title = name; if (t.draft) t.draft.name = name; }
      }
      HD.save();
      HD.renderSidebar();
      HD.renderTabBar();
      HD.renderActiveTab();
    };
    const remove = async () => {
      const what = node.type === 'request' ? 'request' : node.type;
      if (!(await HD.confirm(`Delete ${what}`, `Delete "${node.name}"${node.type !== 'request' ? ' and everything in it' : ''}?${collection && collection.team ? ' It is shared with your team: the next sync deletes it for everyone.' : ''} This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
      const ids = new Set([node.id]);
      HD.walk(node.items || [], (it) => ids.add(it.id));
      found.siblings.splice(found.siblings.indexOf(node), 1);
      S.ws.tabs.filter((t) => ids.has(t.refId)).forEach((t) => HD.closeTab(t.id, true));
      HD.save();
      HD.renderSidebar();
    };
    const duplicate = () => {
      const copy = HD.duplicate(node);
      copy.name = `${node.name} Copy`;
      found.siblings.splice(found.siblings.indexOf(node) + 1, 0, copy);
      HD.save();
      HD.renderSidebar();
    };
    if (node.type === 'request') {
      return [
        { label: 'Open in new tab', onClick: () => HD.openRequest(node.id) },
        { label: 'Rename', onClick: rename },
        { label: 'Duplicate', onClick: duplicate },
        { label: 'Copy as cURL', onClick: async () => {
          const code = await window.api.generateCode({ target: 'curl', request: node.request, chain: [found.collection, ...found.parents].map((n) => ({ auth: n.auth })), scopes: HD.scopesFor(found.collection) }).catch((e) => HD.toast(HD.cleanErr(e), 'error'));
          if (code) HD.copy(code);
        } },
        { separator: true },
        { label: 'Delete', danger: true, onClick: remove },
      ];
    }
    return [
      { label: 'Add request', onClick: () => addRequest(node) },
      { label: 'Add WebSocket request', onClick: () => addRequest(node, HD.newWebSocketDef()) },
      { label: 'Add folder', onClick: async () => {
        const name = await HD.prompt('New folder', 'Name', 'New Folder');
        if (!name) return;
        const f = HD.newFolder(name);
        node.items.push(f);
        expanded()[node.id] = true;
        HD.save();
        HD.renderSidebar();
      } },
      { separator: true },
      { label: node.type === 'collection' ? 'Edit collection' : 'Edit folder', hint: 'auth, scripts, variables', onClick: () => HD.openContainer(node.id) },
      { label: `Run ${node.type}`, onClick: () => HD.openRunner(collection.id, node.type === 'folder' ? node.id : null) },
      { label: 'Rename', onClick: rename },
      { label: 'Duplicate', onClick: duplicate },
      node.type === 'collection' ? { label: 'Export (Postman v2.1)', onClick: () => window.api.exportCollection(node) } : null,
      { separator: true },
      { label: 'Delete', danger: true, onClick: remove },
    ];
  }

  // Where a drop lands on a row: above or below a request (by which half of the row the pointer
  // is over); into a folder from its middle, or above or below it from its top or bottom quarter.
  // A collection only takes things into it.
  function dropPosition(e, row, node) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / (r.height || 1);
    if (node.type === 'collection') return 'into';
    if (node.type === 'folder') return y < 0.25 ? 'before' : y > 0.75 && !expanded()[node.id] ? 'after' : 'into';
    return y < 0.5 ? 'before' : 'after';
  }
  let openTimer = null;
  function clearDrop() {
    clearTimeout(openTimer);
    document.querySelectorAll('.tree-row[data-drop], .tree-row[data-opening]').forEach((r) => {
      r.classList.remove('drop-into', 'drop-before', 'drop-after');
      delete r.dataset.drop;
      delete r.dataset.opening;
    });
  }

  function moveNode(id, target, pos = target.type === 'request' ? 'before' : 'into') {
    const src = HD.find(id);
    if (!src || id === target.id) return;
    // Refuse to move a folder into itself or one of its descendants.
    let inside = false;
    HD.walk(src.node.items || [], (it) => { if (it.id === target.id) inside = true; });
    if (inside) return;
    if (pos !== 'into' && target.type === 'collection') pos = 'into';
    src.siblings.splice(src.siblings.indexOf(src.node), 1);
    if (pos === 'into') {
      target.items.push(src.node);
      expanded()[target.id] = true;
    } else {
      const t = HD.find(target.id);
      t.siblings.splice(t.siblings.indexOf(target) + (pos === 'after' ? 1 : 0), 0, src.node);
    }
    HD.save();
    HD.renderSidebar();
    HD.renderActiveTab();
  }

  // ---- Environments -------------------------------------------------------------------------

  function renderEnvironments(panel) {
    panel.appendChild(toolbar(async () => {
      const name = await HD.prompt('New environment', 'Name', 'New Environment');
      if (!name) return;
      const env = HD.newEnvironment(name);
      S.ws.environments.push(env);
      HD.save();
      HD.renderSidebar();
      HD.renderEnvSelect();
      HD.openEnvironment(env.id);
    }, 'New environment'));
    const list = h('div.tree');
    panel.appendChild(list);
    const f = filter.trim().toLowerCase();
    list.appendChild(h('div.tree-row.env-row', { onclick: () => HD.openGlobals({ preview: true }), ondblclick: () => HD.openGlobals({ pin: true }) }, HD.icon('globe'), h('span.tree-name', 'Globals'), h('span.muted.small', String(S.ws.globals.filter((v) => v.key).length))));
    for (const env of S.ws.environments) {
      if (f && !env.name.toLowerCase().includes(f)) continue;
      const isActive = S.ws.activeEnvironmentId === env.id;
      list.appendChild(h('div.tree-row.env-row', {
        class: isActive ? 'env-active' : '',
        onclick: () => HD.openEnvironment(env.id, { preview: true }),
        ondblclick: () => HD.openEnvironment(env.id, { pin: true }),
        oncontextmenu: (e) => HD.menu(e, envMenu(env)),
      },
      h('button.env-check', {
        type: 'button', title: isActive ? 'Active environment' : 'Set as active',
        onclick: (e) => { e.stopPropagation(); S.ws.activeEnvironmentId = isActive ? null : env.id; HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); HD.refreshVarHighlights(); },
      }, isActive ? HD.icon('check') : null),
      HD.envDot(env),
      h('span.tree-name', env.name),
      teamBadge(env),
      h('span.muted.small', String(env.values.filter((v) => v.key).length)),
      h('button.tree-more', { type: 'button', onclick: (e) => { e.stopPropagation(); HD.menu(e, envMenu(env)); } }, HD.icon('dots'))));
    }
    if (!S.ws.environments.length) list.appendChild(h('div.empty-state.small', 'No environments. Environments hold sets of variables like base URLs and tokens.'));
    HD.renderDiscoverySidebar(list);
  }

  function envMenu(env) {
    return [
      { label: 'Edit', onClick: () => HD.openEnvironment(env.id) },
      { label: 'Set active', onClick: () => { S.ws.activeEnvironmentId = env.id; HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); } },
      { label: 'Duplicate', onClick: () => { const c = HD.clone(env); c.id = HD.uid(); delete c.team; c.name = `${env.name} Copy`; S.ws.environments.push(c); HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); } },
      { label: 'Export', onClick: () => window.api.exportEnvironment(env) },
      { separator: true },
      { label: 'Delete', danger: true, onClick: async () => {
        if (!(await HD.confirm('Delete environment', `Delete "${env.name}"?`, { danger: true, okLabel: 'Delete' }))) return;
        S.ws.environments.splice(S.ws.environments.indexOf(env), 1);
        if (S.ws.activeEnvironmentId === env.id) S.ws.activeEnvironmentId = null;
        S.ws.tabs.filter((t) => t.refId === env.id).forEach((t) => HD.closeTab(t.id, true));
        HD.save();
        HD.renderSidebar();
        HD.renderEnvSelect();
      } },
    ];
  }

  // ---- History ------------------------------------------------------------------------------

  // A history entry of a saved request opens that request, so a tag or an edit goes on it; any other
  // entry opens as a new request, as it was sent.
  const openHistory = (e, opts) => {
    if (e.requestId && HD.find(e.requestId)) return HD.openRequest(e.requestId, opts);
    return HD.openNewRequest(HD.clone(e.request), e.name || e.url, opts);
  };

  function renderHistory(panel) {
    panel.appendChild(toolbar(null, null, HD.button('', async () => {
      if (!(await HD.confirm('Clear history', 'Delete all history entries?', { danger: true, okLabel: 'Clear' }))) return;
      S.ws.history = [];
      HD.save();
      HD.renderSidebar();
    }, { icon: 'trash', ghost: true, title: 'Clear history' })));
    const list = h('div.tree');
    panel.appendChild(list);
    const f = filter.trim().toLowerCase();
    let lastDay = null;
    const items = S.ws.history.filter((e) => !f || (e.url || '').toLowerCase().includes(f) || (e.name || '').toLowerCase().includes(f));
    if (!items.length) list.appendChild(h('div.empty-state.small', 'Requests you send will appear here.'));
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    for (const e of items) {
      const d = new Date(e.time).toDateString();
      if (d !== lastDay) {
        list.appendChild(h('div.history-day', d === today ? 'Today' : d === yesterday ? 'Yesterday' : d));
        lastDay = d;
      }
      list.appendChild(h('div.tree-row.history-row', {
        title: `${e.method} ${e.url}\n${new Date(e.time).toLocaleString()}${e.error ? `\n${e.error}` : ''}`,
        onclick: () => openHistory(e, { preview: true }),
        ondblclick: () => HD.pinTab(HD.currentTab()),
        oncontextmenu: (ev) => HD.menu(ev, [
          { label: 'Open', onClick: () => openHistory(e, { pin: true }) },
          { label: 'Open as a new request', hint: 'a copy, as it was sent', onClick: () => HD.openNewRequest(HD.clone(e.request), e.name || e.url) },
          { label: 'Save to collection', onClick: async () => {
            const loc = await HD.pickLocation('Save request', e.name || e.url);
            if (!loc) return;
            const item = HD.newRequestItem(loc.name, HD.clone(e.request));
            const target = HD.find(loc.folderId || loc.collectionId).node;
            target.items.push(item);
            HD.save();
            HD.renderSidebar();
          } },
          { label: 'Delete', danger: true, onClick: () => { S.ws.history.splice(S.ws.history.indexOf(e), 1); HD.save(); HD.renderSidebar(); } },
        ]),
      },
      h(`span.method-tag.${HD.methodClass(e.method)}`, (e.method || '').slice(0, 6)),
      h('span.tree-name', e.url),
      e.status ? h(`span.small.${HD.statusClass(e.status)}`, String(e.status)) : e.error ? h('span.small.text-error', 'ERR') : null));
    }
  }

  HD.on('history', () => { if ((S.ws.ui.sidebarTab || 'collections') === 'history') HD.renderSidebar(); });
})();
