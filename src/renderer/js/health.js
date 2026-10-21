'use strict';

/* Health profiling: the editor for a request's, folder's or collection's health URL, and the
   response's Health tab (what the service's health endpoint said before, during and after). */
(() => {
  const { h } = HD;
  const S = HD.S;

  const fmt = (v) => (v === undefined ? '–' : v === null ? 'null' : typeof v === 'string' ? v : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)) : JSON.stringify(v));
  const watchList = (cfg) => (Array.isArray(cfg.watch) ? cfg.watch : String(cfg.watch || '').split('\n')).map((s) => s.trim()).filter(Boolean);

  // The config that applies above this node: nearest folder, then the collection.
  const inherited = (collection, parents) => {
    const chain = [collection, ...(parents || [])];
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i] && chain[i].health;
      if (c && c.mode && c.mode !== 'inherit') return c.mode === 'enabled' && String(c.url || '').trim() ? { cfg: c, node: chain[i] } : null;
    }
    return null;
  };

  /**
   * holder: the object that owns `.health` (request definition, folder or collection)
   * opts: { kind, collection, parents, onChange, sample: () => { request, chain, settings } | null }
   *   sample gives a request to read a path-only URL on (the request itself, or one in the folder).
   */
  HD.healthEditor = (holder, opts) => {
    const root = h('div.dep-editor.health-editor');
    const isCollection = opts.kind === 'collection';
    holder.health = holder.health || { mode: isCollection ? 'none' : 'inherit' };
    const cfg = holder.health;
    const changed = () => opts.onChange && opts.onChange();
    let probe = null; // the last "Read it now" answer

    const render = () => {
      HD.clear(root);
      root.appendChild(h('div.dep-head',
        h('div', h('div.section-title.flush', 'Health while it runs'),
          h('div.muted.small', 'Read the service\'s health endpoint before, during and after the request, to see what the server went through while it answered: connections held, queues, memory, a database that went down.'))));
      if (!opts.collection && opts.kind !== 'request') return;
      const modes = isCollection ? [['none', 'Off'], ['enabled', 'Read a health URL']] : [['inherit', 'Inherit from parent'], ['none', 'Off'], ['enabled', 'Read a health URL']];
      root.appendChild(h('div.dep-grid',
        h('label.field', h('span', 'Mode'), HD.select(modes, cfg.mode || (isCollection ? 'none' : 'inherit'), (v) => { cfg.mode = v; changed(); render(); }))));

      if (cfg.mode === 'inherit' || (!cfg.mode && !isCollection)) {
        const from = opts.collection ? inherited(opts.collection, opts.parents) : null;
        root.appendChild(h('div.info-box', from
          ? `Inherited from "${from.node.name}": reads ${from.cfg.url} every ${from.cfg.intervalMs || 250} ms while the request runs.`
          : 'No health URL is set on a parent folder or the collection.'));
        return;
      }
      if (cfg.mode !== 'enabled') return;
      if (cfg.intervalMs === undefined) Object.assign(cfg, { url: cfg.url || '/healthz', intervalMs: 250, sendAuth: false, watch: [] });

      const watchArea = h('textarea.input.health-watch', {
        value: watchList(cfg).join('\n'), rows: 3, spellcheck: 'false', placeholder: 'db.transactions\nreads.lagBytes',
        oninput: (e) => { cfg.watch = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); changed(); },
      });
      root.appendChild(h('div.dep-grid',
        h('label.field', h('span', 'Health URL'),
          h('input.input.mono', { value: cfg.url || '', placeholder: '/healthz or {{orders_url}}/actuator/health', spellcheck: 'false', oninput: (e) => { cfg.url = e.target.value.trim(); changed(); } }),
          h('span.field-help', 'A path such as /healthz is read on each request\'s own host, so a request sent to one instance reads that instance.')),
        h('label.field', h('span', 'Read every (ms)'),
          h('input.input', { type: 'number', min: 50, step: 50, value: cfg.intervalMs || 250, oninput: (e) => { cfg.intervalMs = Math.max(50, Number(e.target.value) || 250); changed(); } }),
          h('span.field-help', 'While the request is in flight. Readings never overlap: the next starts after the last answers.')),
        h('label.field', h('span', 'Only these fields'), watchArea,
          h('span.field-help', 'One per line. Leave empty for every field; db.transactions covers everything under it.'))));
      root.appendChild(h('label.check', h('input', { type: 'checkbox', checked: !!cfg.sendAuth, onchange: (e) => { cfg.sendAuth = e.target.checked; changed(); } }),
        'Send the request\'s Authorization header with it'));

      const out = h('div.health-probe');
      const readNow = async () => {
        const s = opts.sample ? opts.sample() : null;
        HD.clear(out).appendChild(h('div.muted.small', 'Reading…'));
        try {
          probe = await window.api.readHealth({ cfg: HD.clone(cfg), request: s && s.request ? HD.clone(s.request) : null, chain: s ? s.chain : [], scopes: HD.scopesFor(opts.collection), settings: s ? s.settings : S.ws.settings });
        } catch (e) { probe = { error: e.message }; }
        renderProbe(out);
      };
      root.appendChild(h('div.button-row', HD.button('Read it now', readNow, { small: true, icon: 'play' })));
      root.appendChild(out);
      if (probe) renderProbe(out);
    };

    const renderProbe = (out) => {
      HD.clear(out);
      const p = probe;
      if (p.error && !p.status) { out.appendChild(h('div.dep-status.warn', h('span', `${p.url ? `${p.url}: ` : ''}${p.error}`))); return; }
      const fields = Object.entries(p.values || {});
      const watching = new Set(watchList(cfg));
      out.appendChild(h(`div.dep-status.${p.ok ? 'ok' : 'warn'}`,
        h('span', `${p.ok ? 'Healthy' : 'Not healthy'}: ${p.status} in ${HD.formatMs(p.ms)}, ${fields.length} field${fields.length === 1 ? '' : 's'}`),
        h('span.spacer'), h('span.mono.small', p.url)));
      if (!fields.length) return;
      out.appendChild(h('div.table-wrap.health-fields', h('table.data-table',
        h('thead', h('tr', h('th', 'Field'), h('th', 'Value'), h('th', ''))),
        h('tbody', fields.slice(0, 200).map(([k, v]) => h('tr',
          h('td.mono', k), h('td.mono.break', fmt(v)),
          h('td', watching.has(k) ? h('span.muted.small', 'Watched') : HD.button('Watch', () => {
            cfg.watch = [...watchList(cfg), k];
            changed();
            render();
          }, { small: true, ghost: true }))))))));
    };

    render();
    return root;
  };

  // ---- The Health tab ----------------------------------------------------------------------

  const W = 180;
  const H = 30;

  // A field's value over time, with the request's own span shaded: readings before it sit left of
  // the band and the reading after it sits right of it.
  function spark(health, path) {
    const pts = health.samples.filter((s) => s.values && typeof s.values[path] === 'number').map((s) => ({ t: s.t, v: s.values[path], phase: s.phase }));
    if (pts.length < 2) return null;
    const t0 = Math.min(...health.samples.map((s) => s.t), 0);
    const t1 = Math.max(...health.samples.map((s) => s.t), health.requestMs || 0);
    const lo = Math.min(...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v));
    const x = (t) => 4 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 8);
    const y = (v) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'health-spark');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${path}: ${pts.map((p) => fmt(p.v)).join(', ')}`);
    const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.appendChild(e); return e; };
    if (health.requestMs != null) el('rect', { x: x(0), y: 0, width: Math.max(1, x(health.requestMs) - x(0)), height: H, class: 'health-spark-band' });
    el('polyline', { points: pts.map((p) => `${x(p.t)},${y(p.v)}`).join(' '), class: 'health-spark-line' });
    for (const p of pts) {
      const c = el('circle', { cx: x(p.t), cy: y(p.v), r: 2.5, class: 'health-spark-dot' });
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${fmt(p.v)} · ${p.phase} · ${p.t >= 0 ? '+' : ''}${p.t} ms`;
      c.appendChild(title);
    }
    return svg;
  }

  const during = (health, path) => {
    const vals = health.samples.filter((s) => s.phase === 'during' && s.values && path in s.values).map((s) => s.values[path]);
    if (!vals.length) return '–';
    if (vals.every((v) => typeof v === 'number')) {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      return lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
    }
    return [...new Set(vals.map(fmt))].join(', ');
  };

  HD.renderHealth = (content, health) => {
    const moved = health.fields.filter((f) => f.changed);
    const still = health.fields.filter((f) => !f.changed);
    const readings = health.samples.length;
    content.appendChild(h('div.health-summary',
      h(`span.pill${health.ok ? '' : '.removed'}`, health.ok ? 'Healthy throughout' : `Unhealthy in ${health.unhealthy} of ${readings} readings`),
      h('span.muted', `${readings} reading${readings === 1 ? '' : 's'}, every ${health.intervalMs} ms while the request ran${health.requestMs != null ? ` (${HD.formatMs(health.requestMs)})` : ''}`),
      health.slowest != null ? h('span.muted', `health answered in up to ${HD.formatMs(health.slowest)}`) : null,
      h('span.spacer'), h('span.mono.small.muted', health.url)));

    const row = (f) => h('tr',
      h('td.mono', f.path),
      h('td.mono', fmt(f.before)),
      h('td.mono', during(health, f.path)),
      h('td.mono', fmt(f.after)),
      h('td', f.changed && f.numeric ? spark(health, f.path) : null));
    const head = h('thead', h('tr', h('th', 'Field'), h('th', 'Before'), h('th', 'During'), h('th', 'After'), h('th', moved.some((f) => f.numeric) ? 'Over time' : '')));
    if (moved.length) {
      content.appendChild(h('div.section-title.health-title', `Changed while the request ran (${moved.length})`));
      content.appendChild(h('div.table-wrap', h('table.data-table.health-table', head, h('tbody', moved.map(row)))));
    } else if (health.fields.length) {
      content.appendChild(h('div.empty-state.small', 'Nothing in the health answer changed while the request ran.'));
    }
    if (still.length) {
      content.appendChild(h('details.health-more',
        h('summary', `${still.length} field${still.length === 1 ? '' : 's'} that didn't change`),
        h('div.table-wrap', h('table.data-table.health-table',
          h('thead', h('tr', h('th', 'Field'), h('th', 'Value'))),
          h('tbody', still.map((f) => h('tr', h('td.mono', f.path), h('td.mono', fmt(f.before !== undefined ? f.before : f.after)))))))));
    }
    content.appendChild(h('details.health-more',
      h('summary', `Readings (${readings})`),
      h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', h('th', 'When'), h('th', 'Time'), h('th', 'Status'), h('th', 'Answered in'), h('th', 'Healthy'))),
        h('tbody', health.samples.map((s) => h('tr',
          h('td', s.phase),
          h('td.mono', `${s.t >= 0 ? '+' : ''}${s.t} ms`),
          h('td', s.error ? h('span.text-error', s.error) : h(`span.${HD.statusClass(s.status)}`, String(s.status))),
          h('td.mono', HD.formatMs(s.ms)),
          h('td', s.ok ? h('span.text-ok', 'yes') : h('span.text-error', 'no')))))))));
  };

  // One line for the runner: "healthy throughout; db.transactions.waiting 0 → 3 → 0".
  HD.healthLine = (health, limit = 3) => {
    if (!health) return '';
    const moved = health.fields.filter((f) => f.changed).slice(0, limit).map((f) => {
      if (!f.numeric) return `${f.path} ${fmt(f.before)} → ${fmt(f.after)}`;
      const base = f.before === undefined ? f.max : f.before;
      const peak = Math.abs(f.max - base) >= Math.abs(f.min - base) ? f.max : f.min;
      return `${f.path} ${fmt(f.before)} → ${fmt(peak)} → ${fmt(f.after)}`;
    });
    return [health.ok ? 'healthy throughout' : `unhealthy in ${health.unhealthy} of ${health.samples.length} readings`, ...moved].join('; ');
  };
})();
