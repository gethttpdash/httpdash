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
  const IMAGE_ROWS = 500; // a PNG taller than this gets unwieldy (and hits canvas size limits)

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
      let sort = state.sorts.get(value) || null; // { col, dir }; kept so exports follow it
      const cols = [];
      const seen = new Set();
      for (const row of value) for (const key of Object.keys(row || {})) if (!seen.has(key) && cols.length < MAX_COLUMNS) { seen.add(key); cols.push(key); }
      const head = h('tr', h('th.jt-index', '#'), cols.map((c) => h('th', h('button.jt-sort', {
        type: 'button',
        title: 'Sort',
        onclick: (e) => {
          sort = sort && sort.col === c ? (sort.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 };
          state.sorts.set(value, sort);
          head.querySelectorAll('.jt-sort').forEach((b) => b.removeAttribute('data-dir'));
          if (sort) e.currentTarget.setAttribute('data-dir', sort.dir === 1 ? 'asc' : 'desc');
          renderRows();
        },
      }, c))));
      if (sort) { const b = [...head.querySelectorAll('.jt-sort')].find((x) => x.textContent === sort.col); if (b) b.setAttribute('data-dir', sort.dir === 1 ? 'asc' : 'desc'); }
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

  // ---- Export --------------------------------------------------------------------------------

  // The tables in a response: the value itself if it is a list of records, or lists of records
  // inside objects (such as { "data": [...] }).
  const findTables = (value, path = '', depth = 0, out = []) => {
    if (isRecordList(value)) out.push({ path, value });
    else if (isObj(value) && depth < 4) for (const [k, v] of Object.entries(value)) findTables(v, path ? `${path}.${k}` : k, depth + 1, out);
    return out;
  };

  // A table's rows as shown: filtered, and sorted the way its header is sorted.
  const shownRecords = (value, state) => {
    let rows = value.map((v, i) => ({ v, i })).filter((r) => matches(r.v, state.filter));
    const sort = state.sorts.get(value);
    if (sort) rows = sortRows(rows, sort.col, sort.dir);
    return rows.map((r) => r.v);
  };

  // Draws a flattened table as a PNG (at 2x, in the current theme's colors); returns base64.
  function drawTable({ columns, rows }, total) {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const dpr = 2;
    const pad = 10;
    const rowH = 26;
    const headH = 30;
    const cellFont = `12px ${v('--mono')}`;
    const headFont = `600 12px ${v('--font')}`;
    const text = (x) => (x === null || x === undefined ? '' : String(x));
    const clip = (s) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = headFont;
    const widths = columns.map((c) => ctx.measureText(c).width);
    ctx.font = cellFont;
    rows.forEach((r) => r.forEach((x, i) => { widths[i] = Math.max(widths[i], ctx.measureText(clip(text(x))).width); }));
    const colW = widths.map((w) => Math.min(Math.ceil(w) + pad * 2, 360));
    const indexW = Math.ceil(ctx.measureText(String(rows.length)).width) + pad * 2;
    const footer = total > rows.length ? 26 : 0;
    const width = Math.min(indexW + colW.reduce((a, b) => a + b, 0), 16000);
    const height = headH + rows.length * rowH + footer;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = v('--bg');
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = v('--bg-2');
    ctx.fillRect(0, 0, width, headH);
    ctx.textBaseline = 'middle';
    const cellText = (s, x, y, w, color, font) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, rowH);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.fillText(s, x + pad, y + rowH / 2);
      ctx.restore();
    };
    const color = (x) => (typeof x === 'number' ? v('--jt-number') : typeof x === 'boolean' || x === null ? v('--jt-atom') : v('--jt-string'));
    let x = indexW;
    columns.forEach((c, i) => { cellText(c, x, 2, colW[i], v('--text-2'), headFont); x += colW[i]; });
    rows.forEach((r, ri) => {
      const y = headH + ri * rowH;
      cellText(String(ri + 1), 0, y, indexW, v('--text-3'), cellFont);
      let cx = indexW;
      r.forEach((val, ci) => { cellText(clip(text(val)), cx, y, colW[ci], color(val), cellFont); cx += colW[ci]; });
    });
    // Grid lines.
    ctx.strokeStyle = v('--border');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= rows.length; i++) { const y = Math.round(headH + i * rowH) + 0.5; ctx.moveTo(0, y); ctx.lineTo(width, y); }
    const xs = [indexW];
    for (const w of colW) xs.push(xs[xs.length - 1] + w);
    for (const lx of xs) { ctx.moveTo(Math.round(lx) + 0.5, 0); ctx.lineTo(Math.round(lx) + 0.5, headH + rows.length * rowH); }
    ctx.stroke();
    if (footer) {
      ctx.fillStyle = v('--text-3');
      ctx.font = `12px ${v('--font')}`;
      ctx.fillText(`Showing the first ${rows.length} of ${total} rows`, pad, headH + rows.length * rowH + footer / 2);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }

  async function exportTable(t, format, state) {
    const records = shownRecords(t.value, state);
    const name = t.path || 'table';
    try {
      let file;
      if (format === 'png') {
        const flat = await window.api.flattenTable({ records: records.slice(0, IMAGE_ROWS) });
        file = await window.api.savePng({ name, base64: drawTable(flat, records.length) });
      } else {
        file = await window.api.exportTable({ format, name, records });
      }
      if (file) HD.toast(`Saved ${records.length} rows to ${file.split(/[\\/]/).pop()}`, 'success');
    } catch (e) {
      HD.toast(`Could not export: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error', 6000);
    }
  }

  /** Renders value into parent as tables, with a filter box and an Export menu. */
  HD.renderJsonTable = (parent, value) => {
    const holder = h('div.jt-scroll');
    const state = {
      filter: '',
      open: new WeakSet(),
      sorts: new WeakMap(), // record list -> { col, dir }
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
    const tables = findTables(value).slice(0, 8);
    const formats = [['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV'], ['png', 'Image (.png)']];
    const rowsHint = (t) => { const n = shownRecords(t.value, state).length; return `${n} row${n === 1 ? '' : 's'}`; };
    const exportBtn = tables.length ? HD.button('Export', (e) => HD.menu(e, tables.length === 1
      ? formats.map(([f, label]) => ({ label, hint: rowsHint(tables[0]), onClick: () => exportTable(tables[0], f, state) }))
      : tables.flatMap((t) => formats.map(([f, label]) => ({ label: `${t.path || 'Table'} — ${label}`, hint: rowsHint(t), onClick: () => exportTable(t, f, state) })))),
    { icon: 'upload', small: true, ghost: true, title: 'Export the table as Excel, CSV or an image (follows the filter and sort)' }) : null;
    parent.append(
      h('div.jt-bar',
        h('input.input.jt-filter', { type: 'search', placeholder: 'Filter rows', spellcheck: 'false', oninput: HD.debounce((e) => { state.filter = e.target.value.trim().toLowerCase(); draw(); }, 150) }),
        h('span.muted.small', count),
        h('span.spacer'),
        exportBtn),
      holder);
    draw();
  };
})();
