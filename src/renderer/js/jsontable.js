'use strict';

/* JSON as tables: arrays of objects become sortable tables, objects become key/value tables, and
   nested values expand in place. Used by the response viewer's "Table" view.

   Long tables are virtual: only the rows near the visible part of the scroll area are in the page,
   with spacer rows standing in for the rest, so 100,000 rows cost about as much as 50. This works
   for nested tables too, since APIs often wrap their big array ({ "data": [...] }). Row heights are
   measured as rows render, because an expanded value makes its row taller. */
(() => {
  const { h } = HD;
  const VIRTUAL_FROM = 80; // tables with fewer rows render every row
  const ESTIMATE = 30; // row height (px) assumed until a row has been measured
  const OVERSCAN = 600; // px rendered above and below the visible area
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
  // Open cells are remembered by value (state.open), so they stay open when a virtual row re-renders.
  function cell(value, state) {
    const k = kind(value);
    if (k !== 'object' && k !== 'array') {
      const text = k === 'string' ? value : String(value);
      return h(`span.jt-val.jt-${k}`, { title: text.length > 80 ? text : '' }, k === 'string' && text === '' ? '""' : text);
    }
    const empty = Array.isArray(value) ? !value.length : !Object.keys(value).length;
    if (empty) return h('span.jt-val.jt-null', Array.isArray(value) ? '[]' : '{}');
    const box = h('div.jt-nested');
    const btn = h('button.jt-toggle', {
      type: 'button',
      title: Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} keys`,
      onclick: () => {
        if (state.open.has(value)) state.open.delete(value); else state.open.add(value);
        draw();
        state.relayout();
      },
    }, h('span.jt-caret'), summary(value));
    const draw = () => {
      const open = state.open.has(value);
      btn.classList.toggle('open', open);
      HD.clear(box);
      if (open) box.appendChild(node(value, state));
    };
    draw();
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

  /**
   * Fills tbody with rows (an array of anything), rendering each with renderRow(item) -> <tr>.
   * Short lists render fully; long ones keep only the rows near the visible area.
   */
  function fillRows(tbody, rows, renderRow, colSpan, state, afterRender) {
    HD.clear(tbody);
    if (rows.length < VIRTUAL_FROM) {
      for (const r of rows) tbody.appendChild(renderRow(r));
      return;
    }
    const heights = new Float64Array(rows.length).fill(ESTIMATE);
    let offsets = null; // offsets[i] = top of row i; offsets[n] = total height
    const sums = () => {
      if (!offsets) {
        offsets = new Float64Array(rows.length + 1);
        for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + heights[i];
      }
      return offsets;
    };
    const indexAt = (y) => { // first row whose bottom is below y
      const o = sums();
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (o[mid + 1] <= y) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const topPad = h('tr.jt-pad', h('td', { colSpan }));
    const bottomPad = h('tr.jt-pad', h('td', { colSpan }));
    let start = -1;
    let end = -1;
    const rendered = [];

    const update = (force) => {
      if (!tbody.isConnected) return false; // a collapsed parent; this table is gone
      const view = state.scroller.getBoundingClientRect();
      const top = tbody.getBoundingClientRect().top;
      const s = indexAt(Math.max(0, view.top - top - OVERSCAN));
      const e = Math.min(rows.length, indexAt(view.bottom - top + OVERSCAN) + 1);
      if (!force && s === start && e === end) return true;
      start = s;
      end = e;
      for (const tr of rendered) tr.remove();
      rendered.length = 0;
      const frag = document.createDocumentFragment();
      for (let i = s; i < e; i++) { const tr = renderRow(rows[i]); tr.dataset.i = i; rendered.push(tr); frag.appendChild(tr); }
      topPad.after(frag);
      // Measure what was rendered and correct the spacers.
      let changed = false;
      for (const tr of rendered) {
        const i = Number(tr.dataset.i);
        const height = tr.getBoundingClientRect().height;
        if (height && Math.abs(height - heights[i]) > 0.5) { heights[i] = height; changed = true; }
      }
      if (changed) offsets = null;
      if (afterRender) afterRender();
      const o = sums();
      topPad.firstChild.style.height = `${o[s]}px`;
      bottomPad.firstChild.style.height = `${o[rows.length] - o[e]}px`;
      return true;
    };
    tbody.append(topPad, bottomPad);
    state.virtual.add(update);
    requestAnimationFrame(() => update(true));
  }

  // A table for any JSON value; nested values open their own tables.
  function node(value, state) {
    const table = h('table.jt-table');
    const body = h('tbody');

    if (isRecordList(value)) {
      let sort = null; // { col, dir }
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
      const renderRow = (r) => h('tr', h('td.jt-index', String(r.i)), cols.map((c) => h('td', isObj(r.v) && c in r.v ? cell(r.v[c], state) : h('span.jt-missing', ''))));
      // In a virtual table, rows with longer values come and go while scrolling; columns only ever
      // grow, so they don't jump narrower and wider.
      const lockWidths = () => {
        for (const th of head.children) {
          const w = th.getBoundingClientRect().width;
          if (w > (th.lockedWidth || 0)) { th.lockedWidth = w; th.style.minWidth = `${w}px`; }
        }
      };
      const renderRows = () => {
        let rows = value.map((v, i) => ({ v, i })).filter((r) => matches(r.v, state.filter));
        if (sort) rows = sortRows(rows, sort.col, sort.dir);
        fillRows(body, rows, renderRow, cols.length + 1, state, lockWidths);
      };
      renderRows();
      return table;
    }

    // Objects and lists of plain values: one row per key or item.
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    table.classList.add('jt-kv');
    table.append(body);
    const rows = entries.filter(([k, v]) => !state.filter || k.toLowerCase().includes(state.filter) || matches(v, state.filter));
    fillRows(body, rows, ([k, v]) => h('tr', h(`th.jt-key${Array.isArray(value) ? '.jt-index' : ''}`, k), h('td', cell(v, state))), 2, state);
    return table;
  }

  /** Renders value into parent as tables, with a filter box. */
  HD.renderJsonTable = (parent, value) => {
    const holder = h('div.jt-scroll');
    const state = {
      filter: '',
      open: new WeakSet(),
      scroller: holder,
      virtual: new Set(), // update functions of the virtual tables on screen
      // Re-checks every virtual table after scrolling or when a row changed height.
      relayout: () => {
        if (state.pending) return;
        state.pending = requestAnimationFrame(() => {
          state.pending = 0;
          for (const update of [...state.virtual]) if (!update(true)) state.virtual.delete(update);
        });
      },
    };
    holder.addEventListener('scroll', () => {
      if (state.scrollPending) return;
      state.scrollPending = requestAnimationFrame(() => {
        state.scrollPending = 0;
        for (const update of [...state.virtual]) if (!update(false)) state.virtual.delete(update);
      });
    }, { passive: true });
    const draw = () => {
      state.virtual.clear();
      HD.clear(holder);
      holder.appendChild(kind(value) === 'object' || kind(value) === 'array' ? node(value, state) : cell(value, state));
    };
    const count = Array.isArray(value) ? `${value.length} items` : isObj(value) ? `${Object.keys(value).length} keys` : '';
    parent.append(
      h('div.jt-bar',
        h('input.input.jt-filter', { type: 'search', placeholder: 'Filter rows', spellcheck: 'false', oninput: HD.debounce((e) => { state.filter = e.target.value.trim().toLowerCase(); draw(); }, 150) }),
        h('span.muted.small', count)),
      holder);
    draw();
  };
})();
