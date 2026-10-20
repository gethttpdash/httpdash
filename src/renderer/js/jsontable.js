'use strict';

/* JSON as tables: arrays of objects become sortable tables, objects become key/value tables, and
   nested values expand in place. Used by the response viewer's "Table" view. */
(() => {
  const { h } = HD;
  const PAGE = 200; // rows rendered at a time; "Show more" adds the next page
  const MAX_COLUMNS = 60;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  // An array whose items are all objects (or null) reads best as a table with one column per key.
  const isRecordList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x === null || isObj(x)) && v.some(isObj);

  const summary = (v) => (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`);
  const matches = (v, q) => {
    if (!q) return true;
    if (v !== null && typeof v === 'object') return Object.entries(v).some(([k, x]) => k.toLowerCase().includes(q) || matches(x, q));
    return String(v).toLowerCase().includes(q);
  };

  // A cell: primitives as text; objects and arrays as a toggle that opens a nested table below.
  function cell(value, state) {
    const k = kind(value);
    if (k !== 'object' && k !== 'array') {
      const text = k === 'string' ? value : String(value);
      return h(`span.jt-val.jt-${k}`, { title: text.length > 80 ? text : '' }, k === 'string' && text === '' ? '""' : text);
    }
    const empty = Array.isArray(value) ? !value.length : !Object.keys(value).length;
    if (empty) return h('span.jt-val.jt-null', Array.isArray(value) ? '[]' : '{}');
    const box = h('div.jt-nested');
    let open = false;
    const btn = h('button.jt-toggle', {
      type: 'button',
      title: Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} keys`,
      onclick: () => {
        open = !open;
        btn.classList.toggle('open', open);
        HD.clear(box);
        if (open) box.appendChild(node(value, state));
      },
    }, h('span.jt-caret'), summary(value));
    return h('div.jt-cell-wrap', btn, box);
  }

  function sortRows(rows, col, dir) {
    const val = (r) => (isObj(r.v) ? r.v[col] : undefined);
    const rank = (x) => (x === undefined ? 3 : x === null ? 2 : typeof x === 'object' ? 1 : 0);
    return rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }

  // A table for any JSON value; nested values open their own tables.
  function node(value, state) {
    const table = h('table.jt-table');
    const body = h('tbody');
    let shown = PAGE;
    let sort = null; // { col, dir }

    if (isRecordList(value)) {
      const cols = [];
      const seen = new Set();
      for (const row of value) for (const key of Object.keys(row || {})) if (!seen.has(key) && cols.length < MAX_COLUMNS) { seen.add(key); cols.push(key); }
      const head = h('tr', h('th.jt-index', '#'), cols.map((c) => h('th', h('button.jt-sort', {
        type: 'button',
        title: 'Sort',
        onclick: (e) => {
          sort = sort && sort.col === c ? (sort.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 };
          head.querySelectorAll('.jt-sort').forEach((b) => b.removeAttribute('data-dir'));
          if (sort) e.currentTarget.setAttribute('data-dir', sort.dir === 1 ? 'asc' : 'desc');
          renderRows();
        },
      }, c))));
      table.append(h('thead', head), body);
      const renderRows = () => {
        HD.clear(body);
        let rows = value.map((v, i) => ({ v, i })).filter((r) => matches(r.v, state.filter));
        if (sort) rows = sortRows(rows, sort.col, sort.dir);
        for (const r of rows.slice(0, shown)) {
          body.appendChild(h('tr', h('td.jt-index', String(r.i)), cols.map((c) => h('td', isObj(r.v) && c in r.v ? cell(r.v[c], state) : h('span.jt-missing', '')))));
        }
        more(rows.length);
      };
      const more = (total) => {
        if (total <= shown) return;
        body.appendChild(h('tr.jt-more', h('td', { colSpan: cols.length + 1 },
          HD.button(`Show ${Math.min(PAGE, total - shown)} more of ${total - shown}`, () => { shown += PAGE; renderRows(); }, { small: true, ghost: true }))));
      };
      renderRows();
      return table;
    }

    // Objects and lists of plain values: one row per key or item.
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    table.classList.add('jt-kv');
    table.append(body);
    const renderRows = () => {
      HD.clear(body);
      const rows = entries.filter(([k, v]) => !state.filter || k.toLowerCase().includes(state.filter) || matches(v, state.filter));
      for (const [k, v] of rows.slice(0, shown)) body.appendChild(h('tr', h(`th.jt-key${Array.isArray(value) ? '.jt-index' : ''}`, k), h('td', cell(v, state))));
      if (rows.length > shown) {
        body.appendChild(h('tr.jt-more', h('td', { colSpan: 2 },
          HD.button(`Show ${Math.min(PAGE, rows.length - shown)} more of ${rows.length - shown}`, () => { shown += PAGE; renderRows(); }, { small: true, ghost: true }))));
      }
    };
    renderRows();
    return table;
  }

  /** Renders value into parent as tables, with a filter box. */
  HD.renderJsonTable = (parent, value) => {
    const state = { filter: '' };
    const holder = h('div.jt-scroll');
    const draw = () => { HD.clear(holder); holder.appendChild(kind(value) === 'object' || kind(value) === 'array' ? node(value, state) : cell(value, state)); };
    const count = Array.isArray(value) ? `${value.length} items` : isObj(value) ? `${Object.keys(value).length} keys` : '';
    parent.append(
      h('div.jt-bar',
        h('input.input.jt-filter', { type: 'search', placeholder: 'Filter rows', spellcheck: 'false', oninput: HD.debounce((e) => { state.filter = e.target.value.trim().toLowerCase(); draw(); }, 150) }),
        h('span.muted.small', count)),
      holder);
    draw();
  };
})();
