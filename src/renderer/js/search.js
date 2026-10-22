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
   * text must all match. Each word of the text (typed, not yet picked) matches the name, the URL, a tag,
   * the method or a folder or collection the request is in.
   */
  const curatedVersions = (item) => ((S.ws.requestVersions || {})[item.id] || []).filter((v) => v.name || (v.tags || []).length);

  /**
   * The named or tagged versions of a request that match a search: a version's own name and tags
   * count, with its request's tags. A "version" chip matches version names only.
   */
  // ---- Typed text --------------------------------------------------------------------------------
  // Every word typed has to be found, in any order, in one of the places searched (a request's name,
  // URL, tags and method, and the folders and collection it sits in). With fuzzy, a word of 5 letters
  // or more may also be one typo away from a word there: a letter wrong, missing or extra, or two
  // letters swapped ("ordrs" finds "orders", "cusotmer" finds "customer").
  const FUZZY_MIN = 5;
  const words = (text) => String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  // Optimal string alignment distance of at most 1 (a substitution, insertion, deletion or swap).
  const oneTypo = (a, b) => {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      return a.slice(i + 1) === b.slice(i + 1) // one letter wrong
        || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)); // two swapped
    }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // one extra or missing
  };
  const nearOne = (word, w) => w.length >= FUZZY_MIN - 1 && (oneTypo(word, w) || (w.length > word.length && oneTypo(word, w.slice(0, word.length))));
  const nearWord = (word, place) => place.split(/[^a-z0-9]+/).some((w) => nearOne(word, w));
  const wordFound = (word, places, fuzzy) => places.some((p) => p.includes(word))
    || (fuzzy && word.length >= FUZZY_MIN && places.some((p) => nearWord(word, p)));
  HD.textFound = (text, places, fuzzy = false) => {
    const lower = places.map((p) => String(p || '').toLowerCase());
    return words(text).every((w) => wordFound(w, lower, fuzzy));
  };
  // ---- Highlighting --------------------------------------------------------------------------------
  // What to highlight for a search: the typed words (in the field and in "Search for" chips) and the
  // text of name chips.
  HD.searchTerms = (query) => {
    if (!query) return [];
    const tokens = query.tokens || [];
    return [...new Set([
      ...[...tokens.filter((t) => t.kind === 'text').map((t) => t.value), query.text || ''].flatMap(words),
      ...tokens.filter((t) => t.kind === 'name').map((t) => String(t.value).toLowerCase().trim()).filter(Boolean),
    ])];
  };
  /**
   * The [start, end) ranges of text that terms match, merged and in order. With fuzzy, a term of 5
   * letters or more that isn't found as typed marks the words one typo away from it.
   */
  HD.highlightRanges = (text, terms, fuzzy = false) => {
    const lower = String(text || '').toLowerCase();
    const ranges = [];
    for (const term of terms) {
      let found = false;
      for (let i = lower.indexOf(term); term && i !== -1; i = lower.indexOf(term, i + term.length)) { ranges.push([i, i + term.length]); found = true; }
      if (!found && fuzzy && term.length >= FUZZY_MIN) {
        for (const m of lower.matchAll(/[a-z0-9]+/g)) if (nearOne(term, m[0])) ranges.push([m.index, m.index + m[0].length]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
    }
    return merged;
  };
  /** The text with what the terms match wrapped in <mark>, ready to append (the plain text when nothing matches). */
  HD.highlight = (text, terms, fuzzy = false) => {
    const str = String(text == null ? '' : text);
    const ranges = terms && terms.length ? HD.highlightRanges(str, terms, fuzzy) : [];
    if (!ranges.length) return str;
    const out = [];
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) out.push(str.slice(at, a));
      out.push(h('mark.search-hit', str.slice(a, b)));
      at = b;
    }
    if (at < str.length) out.push(str.slice(at));
    return out;
  };

  // Whether a search has typed text (in the field or as a "Search for" chip), the only part typos can affect.
  HD.queryHasText = (query) => !!(query && (String(query.text || '').trim() || (query.tokens || []).some((t) => t.kind === 'text')));

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
        if (t.kind === 'name' && !own(val) && !item.name.toLowerCase().includes(val)) return false;
        if (t.kind === 'name' && own(val)) ownMatch = true;
      }
      // Typed text, word by word: each word in the version's own name or tags, or its request's name or URL.
      const typed = [...tokens.filter((t) => t.kind === 'text').map((t) => t.value), query.text || ''].flatMap(words);
      for (const w of typed) {
        if (own(w)) ownMatch = true;
        else if (!item.name.toLowerCase().includes(w) && !url.includes(w)) return false;
      }
      return ownMatch;
    });
  };

  /**
   * opts: { path: names of the folders and collection the request is in, which typed text also
   * searches; fuzzy: let a word be one typo away (see above); vars: variables to fill the URL in with,
   * so text and url chips also match the real URL (see searchVars) }.
   */
  // {{variables}} in a URL filled in from vars (a few levels deep), so a search can find the real host.
  HD.resolvedUrl = (url, vars) => {
    let out = String(url || '');
    if (!vars) return out;
    for (let i = 0; i < 3 && out.includes('{{'); i++) {
      out = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
    }
    return out;
  };
  // The variables a search may fill URLs in with: those in scope for the collection, secrets left out.
  HD.searchVars = (collection) => {
    const info = HD.variableInfoFor ? HD.variableInfoFor(collection || null) : {};
    const vars = {};
    for (const [k, v] of Object.entries(info)) if (!v.secret) vars[k] = v.value;
    return vars;
  };

  HD.matchRequest = (item, query, { path = [], fuzzy = false, vars = null } = {}) => {
    if (!item || item.type !== 'request') return false;
    if (((query && query.tokens) || []).some((t) => t.kind === 'version')) return false; // only versions have version names
    const req = item.request || {};
    const tags = (req.tags || []).map((t) => t.toLowerCase());
    const name = (item.name || '').toLowerCase();
    const url = String(req.url || '').toLowerCase();
    const realUrl = vars ? HD.resolvedUrl(req.url, vars).toLowerCase() : url;
    const method = String(req.method || 'GET').toUpperCase();
    const anyText = (q) => HD.textFound(q, [name, url, realUrl, method, ...tags, ...path], fuzzy);
    const tokens = (query && query.tokens) || [];
    const methods = tokens.filter((t) => t.kind === 'method').map((t) => t.value.toUpperCase());
    if (methods.length && !methods.includes(method)) return false;
    for (const t of tokens) {
      const v = String(t.value).toLowerCase();
      if (t.kind === 'tag' && !tags.includes(v)) return false;
      if (t.kind === 'url' && !url.includes(v) && !realUrl.includes(v)) return false;
      if (t.kind === 'name' && !name.includes(v)) return false;
      if (t.kind === 'text' && !anyText(v)) return false;
    }
    const text = String((query && query.text) || '').trim().toLowerCase();
    return !text || anyText(text);
  };
  HD.queryActive = (query) => !!(query && ((query.tokens && query.tokens.length) || String(query.text || '').trim()));

  const KIND_LABEL = { tag: 'Tags', method: 'Methods', url: 'URLs', name: 'Names', version: 'Versions', recent: 'Recent searches' };

  // ---- Search history ----------------------------------------------------------------------------
  // The last searches of a search box (its chips and typed text), newest first, kept in the workspace.
  const HISTORY_MAX = 10;
  const historyOf = (key) => {
    const all = (S.ws.ui.searchHistory = S.ws.ui.searchHistory || {});
    return (all[key] = all[key] || []);
  };
  const queryLabel = (q) => [...(q.tokens || []).map((t) => (t.kind === 'tag' ? `#${t.value}` : t.kind === 'text' ? t.value : `${t.kind}:${t.value}`)), String(q.text || '').trim()].filter(Boolean).join(' ');
  const sameQuery = (a, b) => queryLabel(a).toLowerCase() === queryLabel(b).toLowerCase();
  // A search that only grows the last one ("ord", then "orders") replaces it rather than adding another.
  HD.rememberSearch = (key, query) => {
    if (!HD.queryActive(query)) return;
    const entry = { tokens: (query.tokens || []).map((t) => ({ kind: t.kind, value: t.value })), text: String(query.text || '').trim() };
    const list = historyOf(key);
    const last = list[0];
    if (last && last.text && sameQuery({ ...last, text: '' }, { ...entry, text: '' }) && entry.text.toLowerCase().startsWith(last.text.toLowerCase())) list.shift();
    const i = list.findIndex((e) => sameQuery(e, entry));
    if (i !== -1) list.splice(i, 1);
    list.unshift(entry);
    list.splice(HISTORY_MAX);
    HD.save();
  };
  HD.forgetSearch = (key, entry) => {
    const list = historyOf(key);
    const i = list.findIndex((e) => sameQuery(e, entry));
    if (i !== -1) { list.splice(i, 1); HD.save(); }
  };
  const PREFIX = /^(tag|method|url|name|version):\s*/i;

  // The suggestions for what was typed: grouped, a few of each, the most used first.
  function suggestions(text, query, catalog, recent = []) {
    const m = PREFIX.exec(text);
    const only = m ? m[1].toLowerCase() : null;
    const q = (m ? text.slice(m[0].length) : text).trim().toLowerCase();
    const taken = new Set(((query && query.tokens) || []).map((t) => `${t.kind}:${String(t.value).toLowerCase()}`));
    const out = [];
    // An empty field offers the recent searches first (not the one already showing).
    if (!text.trim()) {
      for (const e of recent.filter((r) => !sameQuery(r, query)).slice(0, 5)) out.push({ kind: 'recent', value: e, label: queryLabel(e), group: KIND_LABEL.recent });
    }
    if (q && !only) out.push({ kind: 'text', value: text.trim(), label: `Search for “${text.trim()}”`, hint: 'name, URL, tag, method or folder' });
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
  // beside: a panel (such as the sidebar) to put the menu next to rather than below, so it doesn't
  // cover the results under the field; below it is when there's no room beside.
  const place = (menu, box, { min = 300, max = 520, beside = null } = {}) => {
    const r = box.getBoundingClientRect();
    const panel = beside && beside.getBoundingClientRect();
    if (panel && window.innerWidth - panel.right - 16 >= min) {
      const width = Math.min(max, window.innerWidth - panel.right - 16);
      menu.style.width = `${width}px`;
      menu.style.left = `${panel.right + 6}px`;
      menu.style.top = `${r.top}px`;
      menu.style.maxHeight = `${Math.max(160, Math.min(420, window.innerHeight - r.top - 16))}px`;
      return;
    }
    const width = Math.min(Math.max(r.width, min), max, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.maxHeight = `${Math.max(160, Math.min(340, window.innerHeight - r.bottom - 16))}px`;
  };

  // Each menu and option has an id, so the field can name the highlighted option for screen readers.
  let menus = 0;
  const optionId = (menu, i) => `${menu.id}-${i}`;
  const markActive = (menu, input, active) => {
    let current = null;
    menu.querySelectorAll('.search-option').forEach((el) => {
      const on = Number(el.dataset.i) === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) current = el;
    });
    if (current) { input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };

  // onClick (optional): the chip's label becomes a button, e.g. a request's tag that filters the sidebar by it.
  const tokenChip = (t, onRemove, onClick) => h(`span.search-chip.search-${t.kind}${onClick ? '.clickable' : ''}`,
    t.kind === 'tag' ? h('span.search-chip-kind', '#') : t.kind === 'text' ? null : h('span.search-chip-kind', `${t.kind}:`),
    onClick ? h('span', { role: 'button', tabindex: '0', title: `Show requests tagged #${t.value}`,
      onclick: (e) => { e.stopPropagation(); onClick(t.value); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClick(t.value); } } }, t.value) : h('span', t.value),
    h('button', { type: 'button', title: 'Remove', 'aria-label': `Remove ${t.kind} ${t.value}`, onclick: (e) => { e.stopPropagation(); onRemove(); } }, '×'));

  /**
   * A search field that turns into a dropdown of suggestions (tags, methods, URLs, names from every
   * request) as you type; picking one adds it as a chip. query: { tokens, text } (changed in place).
   * onChange() is called whenever the query changes. Keys: ↑ ↓ to choose, Enter to add, Esc to close,
   * Backspace in an empty field removes the last chip. "tag:", "method:", "url:", "name:" narrow it.
   */
  HD.searchBox = ({ query, onChange, placeholder = 'Search names, URLs and tags', className = '', historyKey = null, menuBeside = null }) => {
    query.tokens = query.tokens || [];
    query.text = query.text || '';
    let items = [];
    let active = 0;
    const chips = h('span.search-chips');
    const menuId = `hd-search-menu-${++menus}`;
    const input = h('input.search-input', { type: 'text', value: query.text, placeholder, spellcheck: 'false', 'aria-autocomplete': 'list', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': placeholder });
    const menu = h('div.search-menu', { id: menuId, role: 'listbox', hidden: true, 'aria-label': 'Suggestions' });
    const box = h(`div.search-box${className ? `.${className}` : ''}`, { onclick: () => input.focus() }, chips, input, menu);

    const drawChips = () => {
      HD.clear(chips).append(...query.tokens.map((t, i) => tokenChip(t, () => { query.tokens.splice(i, 1); drawChips(); onChange(); open(); })));
      input.placeholder = query.tokens.length ? '' : placeholder;
    };
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const open = () => {
      items = suggestions(input.value, query, HD.requestCatalog(), historyKey ? historyOf(historyKey) : []);
      active = 0;
      HD.clear(menu);
      if (!items.length) { close(); return; }
      let group = null;
      items.forEach((it, i) => {
        if (it.group && it.group !== group) { group = it.group; menu.appendChild(h('div.search-group', group)); }
        menu.appendChild(h('div.search-option', {
          id: optionId(menu, i), role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(i === active), dataset: { i: String(i) },
          onmousedown: (e) => { e.preventDefault(); choose(i); },
          onmousemove: () => highlight(i),
        },
        it.kind === 'method' ? h(`span.method-tag.${HD.methodClass(it.value)}`, it.value) : it.kind === 'tag' ? h('span.search-hash', '#') : it.kind === 'text' ? HD.icon('search') : it.kind === 'version' || it.kind === 'recent' ? HD.icon('history') : null,
        h('span.search-label', it.kind === 'method' ? '' : it.label),
        it.hint ? h('span.search-hint', it.kind === 'text' ? it.hint : `${it.hint} request${it.hint === '1' ? '' : 's'}`) : null,
        it.kind === 'recent' ? h('button.search-forget', {
          type: 'button', title: 'Remove from recent searches', 'aria-label': `Remove ${it.label} from recent searches`,
          onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); HD.forgetSearch(historyKey, it.value); open(); },
        }, '×') : null));
      });
      menu.hidden = false;
      place(menu, box, { beside: menuBeside && box.closest(menuBeside) });
      input.setAttribute('aria-expanded', 'true');
      markActive(menu, input, active);
    };
    const highlight = (i) => {
      active = i;
      markActive(menu, input, active);
    };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      if (it.kind === 'recent') {
        // A recent search replaces what's there, chips and text.
        query.tokens = it.value.tokens.map((t) => ({ ...t }));
        query.text = it.value.text || '';
        input.value = query.text;
        drawChips();
        onChange();
        HD.rememberSearch(historyKey, query);
        close();
        return;
      }
      query.tokens.push({ kind: it.kind, value: it.value });
      input.value = '';
      query.text = '';
      drawChips();
      onChange();
      open();
    };

    input.addEventListener('focus', open);
    // A search counts as done when the field is left with something in it (e.g. to open a result).
    input.addEventListener('blur', () => { setTimeout(close, 100); if (historyKey) HD.rememberSearch(historyKey, query); });
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
  HD.tagInput = ({ tags, onChange, onTagClick = null }) => {
    let items = [];
    let active = 0;
    const chips = h('span.search-chips');
    const menuId = `hd-search-menu-${++menus}`;
    const input = h('input.search-input.tag-input', { type: 'text', placeholder: 'Add a tag', spellcheck: 'false', 'aria-label': 'Add a tag', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': menuId });
    const menu = h('div.search-menu', { id: menuId, role: 'listbox', hidden: true, 'aria-label': 'Tags in use' });
    const box = h('div.search-box.tag-box', { onclick: () => input.focus() }, h('span.tag-box-icon', { title: 'Tags' }, '#'), chips, input, menu);
    const set = (next) => { const n = HD.normalizeTags(next); tags.splice(0, tags.length, ...n); drawChips(); onChange(); };
    const drawChips = () => HD.clear(chips).append(...tags.map((t, i) => tokenChip({ kind: 'tag', value: t }, () => set(tags.filter((_, j) => j !== i)), onTagClick)));
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
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
        id: optionId(menu, i), role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(i === active), dataset: { i: String(i) },
        onmousedown: (e) => { e.preventDefault(); add(it.value); },
        onmousemove: () => { active = i; open.highlight(); },
      }, h('span.search-hash', '#'), h('span.search-label', it.value), h('span.search-hint', it.hint))));
      menu.hidden = false;
      place(menu, input, { min: 260, max: 320 });
      input.setAttribute('aria-expanded', 'true');
      open.highlight();
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
    open.highlight = () => markActive(menu, input, active);
    drawChips();
    return box;
  };
})();
