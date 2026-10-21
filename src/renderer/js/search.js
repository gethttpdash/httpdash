'use strict';

/* Request tags, and the search box that suggests tags, methods, URLs and names from every request. */
(() => {
  const { h } = HD;
  const S = HD.S;

  const MAX_TAGS = 20;
  const MAX_TAG = 40;

  /** Trimmed, comma-free, at most 40 characters, no duplicates (ignoring case), at most 20. */
  HD.normalizeTags = (list) => {
    const seen = new Set();
    const out = [];
    for (const raw of list || []) {
      const t = String(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG);
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push(t);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  };

  const urlKey = (url) => String(url || '').split('#')[0].split('?')[0];

  /**
   * Everything the search can suggest, from every request in the workspace: tags, methods, URLs (without
   * their query) and names, each with how many requests have it, most used first.
   */
  // A request as its open tab shows it: unsaved edits (a new tag, a new name) count right away.
  HD.liveItem = (item) => {
    const tab = item && (S.ws.tabs || []).find((t) => t.kind === 'request' && t.refId === item.id && t.dirty && t.draft);
    return tab ? { ...item, name: tab.draft.name, request: tab.draft.request } : item;
  };
  // Open tabs whose request isn't saved anywhere (new ones, history copies), as search sees them.
  HD.unsavedTabItems = () => (S.ws.tabs || []).filter((t) => t.kind === 'request' && !t.refId && t.draft)
    .map((t) => ({ id: t.id, type: 'request', name: t.draft.name, request: t.draft.request, tabId: t.id }));

  HD.requestCatalog = () => {
    const tags = new Map();
    const methods = new Map();
    const urls = new Map();
    const names = new Map();
    const versions = new Map();
    const bump = (m, key, label) => { if (!key) return; const e = m.get(key) || { value: label, count: 0 }; e.count++; m.set(key, e); };
    const count = (it) => {
      for (const t of it.request.tags || []) bump(tags, t.toLowerCase(), t);
      bump(methods, String(it.request.method || 'GET').toUpperCase(), String(it.request.method || 'GET').toUpperCase());
      const u = urlKey(it.request.url);
      bump(urls, u, u);
      bump(names, (it.name || '').toLowerCase(), it.name);
    };
    for (const it of HD.unsavedTabItems()) count(it);
    for (const col of S.ws.collections) {
      HD.walk(col.items, (raw) => {
        if (raw.type !== 'request' || !raw.request) return;
        const it = HD.liveItem(raw);
        count(it);
        // Named or tagged versions of the request (see versions.js).
        for (const v of curatedVersions(raw)) {
          if (v.name) bump(versions, v.name.toLowerCase(), v.name);
          for (const t of v.tags || []) bump(tags, t.toLowerCase(), t);
        }
      });
    }
    const list = (m) => [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return { tags: list(tags), methods: list(methods), urls: list(urls), names: list(names), versions: list(versions) };
  };

  /**
   * Whether a request matches a search: { tokens: [{ kind: 'tag'|'method'|'url'|'name'|'text', value }], text }.
   * Every tag must be on the request; any one of the methods will do (a request has one); URL, name and
   * text must all match. Text (typed, not yet picked) matches the name, the URL or a tag.
   */
  const curatedVersions = (item) => ((S.ws.requestVersions || {})[item.id] || []).filter((v) => v.name || (v.tags || []).length);

  /**
   * The named or tagged versions of a request that match a search: a version's own name and tags
   * count, with its request's tags. A "version" chip matches version names only.
   */
  HD.matchingVersions = (item, query) => {
    if (!item || item.type !== 'request' || !HD.queryActive(query)) return [];
    const reqTags = (item.request.tags || []).map((t) => t.toLowerCase());
    return curatedVersions(item).filter((v) => {
      const tags = [...reqTags, ...(v.tags || []).map((t) => t.toLowerCase())];
      const name = String(v.name || '').toLowerCase();
      const url = String(v.request.url || '').toLowerCase();
      const own = (q) => name.includes(q) || (v.tags || []).some((t) => t.toLowerCase().includes(q));
      const tokens = query.tokens || [];
      const methods = tokens.filter((t) => t.kind === 'method').map((t) => t.value.toUpperCase());
      if (methods.length && !methods.includes(String(v.request.method || 'GET').toUpperCase())) return false;
      let ownMatch = false;
      for (const t of tokens) {
        const val = String(t.value).toLowerCase();
        if (t.kind === 'tag') { if (!tags.includes(val)) return false; if ((v.tags || []).some((x) => x.toLowerCase() === val)) ownMatch = true; }
        if (t.kind === 'version') { if (!name.includes(val)) return false; ownMatch = true; }
        if (t.kind === 'url' && !url.includes(val)) return false;
        if ((t.kind === 'text' || t.kind === 'name') && !own(val) && !item.name.toLowerCase().includes(val)) return false;
        if ((t.kind === 'text' || t.kind === 'name') && own(val)) ownMatch = true;
      }
      const text = String(query.text || '').trim().toLowerCase();
      if (text) { if (!own(text) && !item.name.toLowerCase().includes(text) && !url.includes(text)) return false; if (own(text)) ownMatch = true; }
      return ownMatch;
    });
  };

  HD.matchRequest = (item, query) => {
    if (!item || item.type !== 'request') return false;
    if (((query && query.tokens) || []).some((t) => t.kind === 'version')) return false; // only versions have version names
    const req = item.request || {};
    const tags = (req.tags || []).map((t) => t.toLowerCase());
    const name = (item.name || '').toLowerCase();
    const url = String(req.url || '').toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();
    const anyText = (q) => name.includes(q) || url.includes(q) || tags.some((t) => t.includes(q));
    const tokens = (query && query.tokens) || [];
    const methods = tokens.filter((t) => t.kind === 'method').map((t) => t.value.toUpperCase());
    if (methods.length && !methods.includes(method)) return false;
    for (const t of tokens) {
      const v = String(t.value).toLowerCase();
      if (t.kind === 'tag' && !tags.includes(v)) return false;
      if (t.kind === 'url' && !url.includes(v)) return false;
      if (t.kind === 'name' && !name.includes(v)) return false;
      if (t.kind === 'text' && !anyText(v)) return false;
    }
    const text = String((query && query.text) || '').trim().toLowerCase();
    return !text || anyText(text);
  };
  HD.queryActive = (query) => !!(query && ((query.tokens && query.tokens.length) || String(query.text || '').trim()));

  const KIND_LABEL = { tag: 'Tags', method: 'Methods', url: 'URLs', name: 'Names', version: 'Versions' };
  const PREFIX = /^(tag|method|url|name|version):\s*/i;

  // The suggestions for what was typed: grouped, a few of each, the most used first.
  function suggestions(text, query, catalog) {
    const m = PREFIX.exec(text);
    const only = m ? m[1].toLowerCase() : null;
    const q = (m ? text.slice(m[0].length) : text).trim().toLowerCase();
    const taken = new Set(((query && query.tokens) || []).map((t) => `${t.kind}:${String(t.value).toLowerCase()}`));
    const out = [];
    if (q && !only) out.push({ kind: 'text', value: text.trim(), label: `Search for “${text.trim()}”`, hint: 'name, URL or tag' });
    const pick = (kind, list, limit) => {
      if (only && only !== kind) return;
      const found = list.filter((e) => !taken.has(`${kind}:${e.value.toLowerCase()}`) && (!q || e.value.toLowerCase().includes(q))).slice(0, only ? 20 : limit);
      for (const e of found) out.push({ kind, value: e.value, label: e.value, hint: `${e.count}` , group: KIND_LABEL[kind] });
    };
    pick('tag', catalog.tags, q ? 6 : 8);
    pick('method', catalog.methods, q ? 3 : 7);
    if (q || only) {
      pick('version', catalog.versions, 5);
      pick('url', catalog.urls, 5);
      pick('name', catalog.names, 5);
    }
    return out;
  }

  // Menus are placed against the window, so a narrow panel neither clips them nor gains a scrollbar.
  const place = (menu, box, { min = 300, max = 520 } = {}) => {
    const r = box.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, min), max, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.maxHeight = `${Math.max(160, Math.min(340, window.innerHeight - r.bottom - 16))}px`;
  };

  const tokenChip = (t, onRemove) => h(`span.search-chip.search-${t.kind}`,
    t.kind === 'tag' ? h('span.search-chip-kind', '#') : t.kind === 'text' ? null : h('span.search-chip-kind', `${t.kind}:`),
    h('span', t.value),
    h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${t.kind} ${t.value}`, onclick: (e) => { e.stopPropagation(); onRemove(); } }, '×'));

  /**
   * A search field that turns into a dropdown of suggestions (tags, methods, URLs, names from every
   * request) as you type; picking one adds it as a chip. query: { tokens, text } (changed in place).
   * onChange() is called whenever the query changes. Keys: ↑ ↓ to choose, Enter to add, Esc to close,
   * Backspace in an empty field removes the last chip. "tag:", "method:", "url:", "name:" narrow it.
   */
  HD.searchBox = ({ query, onChange, placeholder = 'Search or #tag', className = '' }) => {
    query.tokens = query.tokens || [];
    query.text = query.text || '';
    let items = [];
    let active = 0;
    const chips = h('span.search-chips');
    const input = h('input.search-input', { type: 'text', value: query.text, placeholder, spellcheck: 'false', 'aria-autocomplete': 'list', role: 'combobox', 'aria-expanded': 'false' });
    const menu = h('div.search-menu', { role: 'listbox', hidden: true });
    const box = h(`div.search-box${className ? `.${className}` : ''}`, { onclick: () => input.focus() }, chips, input, menu);

    const drawChips = () => {
      HD.clear(chips).append(...query.tokens.map((t, i) => tokenChip(t, () => { query.tokens.splice(i, 1); drawChips(); onChange(); open(); })));
      input.placeholder = query.tokens.length ? '' : placeholder;
    };
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const open = () => {
      items = suggestions(input.value, query, HD.requestCatalog());
      active = 0;
      HD.clear(menu);
      if (!items.length) { close(); return; }
      let group = null;
      items.forEach((it, i) => {
        if (it.group && it.group !== group) { group = it.group; menu.appendChild(h('div.search-group', group)); }
        menu.appendChild(h('div.search-option', {
          role: 'option', class: i === active ? 'active' : '', dataset: { i: String(i) },
          onmousedown: (e) => { e.preventDefault(); choose(i); },
          onmousemove: () => highlight(i),
        },
        it.kind === 'method' ? h(`span.method-tag.${HD.methodClass(it.value)}`, it.value) : it.kind === 'tag' ? h('span.search-hash', '#') : it.kind === 'text' ? HD.icon('search') : it.kind === 'version' ? HD.icon('history') : null,
        h('span.search-label', it.kind === 'method' ? '' : it.label),
        it.hint ? h('span.search-hint', it.kind === 'text' ? it.hint : `${it.hint} request${it.hint === '1' ? '' : 's'}`) : null));
      });
      menu.hidden = false;
      place(menu, box);
      input.setAttribute('aria-expanded', 'true');
    };
    const highlight = (i) => {
      active = i;
      menu.querySelectorAll('.search-option').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
      const el = menu.querySelector('.search-option.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      query.tokens.push({ kind: it.kind, value: it.value });
      input.value = '';
      query.text = '';
      drawChips();
      onChange();
      open();
    };

    input.addEventListener('focus', open);
    input.addEventListener('blur', () => setTimeout(close, 100));
    input.addEventListener('input', () => { query.text = PREFIX.test(input.value) ? '' : input.value; onChange(); open(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); if (menu.hidden) open(); else highlight((active + 1) % items.length); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!menu.hidden && items.length) choose(active); }
      else if (e.key === 'Escape') { if (!menu.hidden) { e.stopPropagation(); close(); } else if (input.value) { input.value = ''; query.text = ''; onChange(); } }
      else if (e.key === 'Backspace' && !input.value && query.tokens.length) { query.tokens.pop(); drawChips(); onChange(); open(); }
    });
    drawChips();
    return box;
  };

  /**
   * The tags of a request: chips, and a field that suggests the tags already used elsewhere.
   * Enter or a comma adds what was typed; Backspace in an empty field removes the last tag.
   */
  HD.tagInput = ({ tags, onChange }) => {
    let items = [];
    let active = 0;
    const chips = h('span.search-chips');
    const input = h('input.search-input.tag-input', { type: 'text', placeholder: 'Add a tag', spellcheck: 'false', 'aria-label': 'Add a tag', role: 'combobox', 'aria-autocomplete': 'list' });
    const menu = h('div.search-menu', { role: 'listbox', hidden: true });
    const box = h('div.search-box.tag-box', { onclick: () => input.focus() }, h('span.tag-box-icon', { title: 'Tags' }, '#'), chips, input, menu);
    const set = (next) => { const n = HD.normalizeTags(next); tags.splice(0, tags.length, ...n); drawChips(); onChange(); };
    const drawChips = () => HD.clear(chips).append(...tags.map((t, i) => tokenChip({ kind: 'tag', value: t }, () => set(tags.filter((_, j) => j !== i)))));
    const close = () => { menu.hidden = true; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      const mine = new Set(tags.map((t) => t.toLowerCase()));
      const known = HD.requestCatalog().tags.filter((t) => !mine.has(t.value.toLowerCase()) && (!q || t.value.toLowerCase().includes(q)));
      items = known.slice(0, 8).map((t) => ({ value: t.value, hint: `${t.count} request${t.count === 1 ? '' : 's'}` }));
      if (q && !known.some((t) => t.value.toLowerCase() === q) && !mine.has(q)) items.push({ value: input.value.trim(), hint: 'new tag' });
      active = 0;
      HD.clear(menu);
      if (!items.length) { close(); return; }
      items.forEach((it, i) => menu.appendChild(h('div.search-option', {
        role: 'option', class: i === active ? 'active' : '', dataset: { i: String(i) },
        onmousedown: (e) => { e.preventDefault(); add(it.value); },
        onmousemove: () => { active = i; menu.querySelectorAll('.search-option').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i)); },
      }, h('span.search-hash', '#'), h('span.search-label', it.value), h('span.search-hint', it.hint))));
      menu.hidden = false;
      place(menu, input, { min: 260, max: 320 });
    };
    const add = (value) => { input.value = ''; set([...tags, value]); open(); };
    input.addEventListener('focus', open);
    input.addEventListener('blur', () => { setTimeout(close, 100); if (input.value.trim()) add(input.value); });
    input.addEventListener('input', () => { if (input.value.includes(',')) { const parts = input.value.split(','); input.value = parts.pop(); set([...tags, ...parts]); } open(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; open.highlight(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = (active - 1 + items.length) % items.length; open.highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!menu.hidden && items[active]) add(items[active].value); else if (input.value.trim()) add(input.value); }
      else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Backspace' && !input.value && tags.length) set(tags.slice(0, -1));
    });
    open.highlight = () => menu.querySelectorAll('.search-option').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
    drawChips();
    return box;
  };
})();
