'use strict';

/* The environment diagram: this computer, the environment's service endpoints, the load balancers
   in front of them and the instances behind, grouped into network clusters (a namespace, a
   datacenter or a zone, and a network segment). Built by core/topology.js from discovery, DNS and
   the traffic sent since HttpDash started; laid out automatically and refreshed while it's shown.
   Nodes can be moved; where they were put is kept per environment (S.ws.ui.diagrams). */
(() => {
  const { h } = HD;
  const S = HD.S;
  const NODE_W = 220;
  const NODE_H = 74;
  const COL_GAP = 96;
  const ROW_GAP = 14;
  const GROUP_PAD = 14;
  const GROUP_HEAD = 28;
  const GROUP_GAP = 30;
  const MARGIN = 24;
  const REFRESH_MS = 2000;
  const KIND_LABEL = { client: 'Client', tunnel: 'Tunnel', endpoint: 'Endpoint', balancer: 'Balancer', instance: 'Instance' };
  const FLAG_LABEL = { slow: 'slow', failing: 'failing', left: 'left the pool', unhealthy: 'unhealthy', hidden: 'not listed' };
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs = {}) => { const el = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

  const savedPositions = (envId) => {
    const all = (S.ws.ui.diagrams = S.ws.ui.diagrams || {});
    return (all[envId] = all[envId] || {});
  };

  /** The graph's layout: { pos: { id: { x, y } }, boxes: [{ group, x, y, w, h }], width, height }. */
  function layout(g, envId) {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const children = (id) => g.edges.filter((e) => e.from === id).map((e) => byId.get(e.to));
    const kinds = ['client', 'tunnel', 'endpoint', 'balancer', 'instance'].filter((k) => g.nodes.some((n) => n.kind === k));
    const colX = Object.fromEntries(kinds.map((k, i) => [k, MARGIN + i * (NODE_W + COL_GAP) + (k === 'instance' ? GROUP_PAD : 0)]));
    const pos = {};
    // The instances, cluster by cluster, in the order the endpoints reach them.
    const order = [];
    const visit = (n) => { for (const c of children(n.id)) { if (c.kind === 'instance') { if (!order.includes(c)) order.push(c); } else visit(c); } };
    g.nodes.filter((n) => n.kind === 'endpoint').forEach(visit);
    const groupOrder = [...new Set(order.map((n) => n.group))];
    let y = MARGIN;
    for (const gid of groupOrder) {
      const members = order.filter((n) => n.group === gid);
      members.forEach((n, i) => { pos[n.id] = { x: colX.instance, y: y + GROUP_HEAD + i * (NODE_H + ROW_GAP) }; });
      y += GROUP_HEAD + members.length * (NODE_H + ROW_GAP) - ROW_GAP + GROUP_PAD + GROUP_GAP;
    }
    // Each node sits level with the middle of what it leads to; then a column is spread so none overlap.
    const centre = (n) => {
      const ys = children(n.id).map((c) => pos[c.id] && pos[c.id].y).filter((v) => v != null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    };
    for (const kind of ['balancer', 'endpoint', 'tunnel', 'client']) {
      const col = g.nodes.filter((n) => n.kind === kind);
      for (const n of col) { const c = centre(n); pos[n.id] = { x: colX[kind], y: c != null ? c : MARGIN }; }
      const sorted = [...col].sort((a, b) => pos[a.id].y - pos[b.id].y);
      let floor = MARGIN;
      for (const n of sorted) { pos[n.id].y = Math.max(pos[n.id].y, floor); floor = pos[n.id].y + NODE_H + ROW_GAP; }
    }
    // Where someone put a node wins.
    const saved = savedPositions(envId);
    for (const [id, p] of Object.entries(saved)) if (pos[id]) pos[id] = { ...p };
    // A cluster's box holds its instances wherever they are.
    const boxes = g.groups.map((group) => {
      const members = g.nodes.filter((n) => n.group === group.id && pos[n.id]);
      if (!members.length) return null;
      const xs = members.map((n) => pos[n.id].x);
      const ys = members.map((n) => pos[n.id].y);
      const x = Math.min(...xs) - GROUP_PAD;
      const top = Math.min(...ys) - GROUP_HEAD;
      return { group, x, y: top, w: Math.max(...xs) - Math.min(...xs) + NODE_W + 2 * GROUP_PAD, h: Math.max(...ys) - top + NODE_H + GROUP_PAD };
    }).filter(Boolean);
    const width = Math.max(...Object.values(pos).map((p) => p.x + NODE_W), ...boxes.map((b) => b.x + b.w), 0) + MARGIN;
    const height = Math.max(...Object.values(pos).map((p) => p.y + NODE_H), ...boxes.map((b) => b.y + b.h), 0) + MARGIN;
    return { pos, boxes, width, height };
  }

  const fmtStats = (n) => {
    const s = n.stats;
    if (s && s.requests) return [`${s.requests} req`, s.p95 ? `p95 ${HD.formatMs(s.p95)}` : null, s.share != null ? `${Math.round(s.share * 100)}%` : null, s.errors ? `${s.errors} failed` : null].filter(Boolean).join(' · ');
    if (n.requests) return `${n.requests} req`;
    return n.kind === 'instance' ? 'no requests yet' : '';
  };

  /** Draws the diagram of `env` into a new element (the Diagram page of an environment). */
  HD.envDiagram = (tab, env) => {
    const ui = (tab.ui = tab.ui || {});
    ui.dgZoom = ui.dgZoom || 1;
    const wrap = h('div.dg-wrap');
    const sizer = h('div.dg-sizer');
    const canvas = h('div.dg-canvas');
    sizer.appendChild(canvas);
    wrap.appendChild(sizer);
    const panel = h('div.dg-panel');
    const summary = h('span.muted.small');
    const zoomLabel = h('span.dg-zoom.small');
    const bar = h('div.dg-bar',
      summary, h('span.spacer'),
      HD.button('', () => setZoom(ui.dgZoom - 0.1), { icon: 'minus', ghost: true, small: true, title: 'Zoom out (Ctrl/Cmd + wheel)' }),
      zoomLabel,
      HD.button('', () => setZoom(ui.dgZoom + 0.1), { icon: 'plus', ghost: true, small: true, title: 'Zoom in' }),
      HD.button('Fit', () => fit(), { ghost: true, small: true, title: 'Fit the diagram in the window' }),
      HD.button('Tidy', () => { S.ws.ui.diagrams[env.id] = {}; HD.save(); draw(); }, { ghost: true, small: true, title: 'Put every node back where the automatic layout puts it' }),
      HD.button('', () => refresh(), { icon: 'refresh', ghost: true, small: true, title: 'Read the registry\'s last sync, DNS and traffic again' }));
    const view = h('div.dg-view', bar, h('div.dg-main', wrap, panel));
    let graph = null;
    let laid = null;
    let dragging = null;

    const setZoom = (z) => {
      ui.dgZoom = Math.max(0.3, Math.min(1.6, Math.round(z * 10) / 10));
      HD.save();
      applyZoom();
    };
    const applyZoom = () => {
      canvas.style.transform = `scale(${ui.dgZoom})`;
      if (laid) { sizer.style.width = `${laid.width * ui.dgZoom}px`; sizer.style.height = `${laid.height * ui.dgZoom}px`; }
      zoomLabel.textContent = `${Math.round(ui.dgZoom * 100)}%`;
    };
    const fit = () => {
      if (!laid) return;
      const z = Math.min((wrap.clientWidth - 8) / laid.width, (wrap.clientHeight - 8) / laid.height, 1.2);
      setZoom(Math.max(0.3, z));
    };
    wrap.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(ui.dgZoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    const selectNode = (id) => { ui.dgSelected = id; HD.save(); draw(); };

    const renderPanel = () => {
      HD.clear(panel);
      const n = graph && graph.nodes.find((x) => x.id === ui.dgSelected);
      if (!n) {
        panel.append(h('div.dg-panel-title', 'Environment diagram'),
          h('div.muted.small', 'This computer, the service endpoints (the environment\'s URL variables), the load balancers in front of them, and the instances behind, grouped into network clusters.'),
          h('div.dg-legend',
            h('div', h('span.dg-swatch.dg-ok'), 'carried requests: thicker for more'),
            h('div', h('span.dg-swatch.dg-err'), 'one in five or more failed'),
            h('div', h('span.dg-swatch.dg-idle'), 'no requests since HttpDash started')),
          h('div.muted.small', 'Click a node for its details. Drag nodes to move them; Tidy puts them back.'));
        return;
      }
      const m = n.meta || {};
      const rows = [
        ['Address', m.address], ['URL', m.url], ['Host', m.host], ['Service', m.service], ['Variable', m.variable && `{{${m.variable}}}`],
        ['Registry', m.source && (typeof m.source === 'string' ? m.source : `${m.source.name} (${m.source.provider})`)], ['Namespace', m.namespace], ['Node', m.node],
        ['Datacenter', m.dc], ['Zone', m.zone], ['Type', m.type], ['Cluster IP', m.clusterIp], ['Outside address', m.external], ['Instance header', m.header],
        ['Named itself', m.servedBy], ['Connected to', m.connectedTo], ['How', m.spreads],
      ].filter(([, v]) => v);
      const s = n.stats;
      const sourceId = m.sourceId || (m.source && m.source.id);
      panel.append(...[
        h('div.dg-panel-kind', KIND_LABEL[n.kind]),
        h('div.dg-panel-title', n.label),
        n.detail ? h('div.muted.small', n.detail) : null,
        n.flags.length ? h('div.dg-flags', n.flags.map((f) => h(`span.pill.dg-flag-${f}`, FLAG_LABEL[f] || f))) : null,
        m.byHand ? h('div.small.dg-warn', 'This variable no longer holds the URL discovery gave it, so requests go where it says, not to the service\'s instances.') : null,
        h('table.dg-props', rows.map(([k, v]) => h('tr', h('th', k), h('td', String(v))))),
        s && s.requests ? h('table.dg-props', h('tr', h('th', 'Requests'), h('td', String(s.requests))), h('tr', h('th', 'Share'), h('td', s.share != null ? `${Math.round(s.share * 100)}%` : '—')), h('tr', h('th', 'p50 / p95'), h('td', `${HD.formatMs(s.p50)} / ${HD.formatMs(s.p95)}`)), h('tr', h('th', 'Failed'), h('td', String(s.errors)))) : null,
        (m.interfaces || []).length ? h('table.dg-props', m.interfaces.map((i) => h('tr', h('th', i.name), h('td', `${i.address} (${i.cidr})`)))) : null,
        h('div.button-row',
          sourceId ? HD.button('Traffic', () => HD.openDiscovery(sourceId, 'traffic'), { small: true, title: 'Every request to this source\'s instances' }) : null,
          m.url ? HD.button('Copy URL', () => HD.copy(m.url), { small: true, ghost: true }) : null,
          HD.button('Close', () => selectNode(null), { small: true, ghost: true })),
      ].filter(Boolean)); // append() would show a null as text
    };

    const draw = () => {
      HD.clear(canvas);
      if (!graph) return;
      const instances = graph.nodes.filter((n) => n.kind === 'instance');
      summary.textContent = `${graph.nodes.filter((n) => n.kind === 'endpoint').length} endpoints · ${instances.length} instances · ${graph.groups.length} network clusters`;
      if (!graph.nodes.some((n) => n.kind === 'endpoint')) {
        canvas.appendChild(h('div.empty-state.dg-empty', 'No URL variables in this environment yet. Add one (orders_url = http://…), or sync a service discovery source into it, and its services appear here.'));
        laid = { width: 600, height: 200, pos: {}, boxes: [] };
        applyZoom();
        renderPanel();
        return;
      }
      laid = layout(graph, env.id);
      const { pos, boxes } = laid;
      for (const b of boxes) {
        canvas.appendChild(h(`div.dg-group${b.group.own ? '.dg-group-own' : ''}`, { style: { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` } },
          h('div.dg-group-label', b.group.label, b.group.kind ? h('span.muted', ` · ${b.group.kind}`) : null, b.group.own ? h('span.muted', ` · this computer's ${b.group.own}`) : null)));
      }
      const svg = svgEl('svg', { class: 'dg-edges', width: laid.width, height: laid.height });
      const max = Math.max(1, ...graph.edges.map((e) => e.requests || 0));
      for (const e of graph.edges) {
        const a = pos[e.from];
        const b = pos[e.to];
        if (!a || !b) continue;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const dx = Math.max(40, (x2 - x1) / 2);
        const path = svgEl('path', {
          d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
          class: `dg-edge dg-edge-${e.state}`,
          'stroke-width': e.requests ? (1.5 + 6 * Math.sqrt(e.requests / max)).toFixed(1) : 1.5,
        });
        const title = svgEl('title');
        title.textContent = e.requests ? `${e.requests} requests${e.share != null ? ` (${Math.round(e.share * 100)}%)` : ''}${e.errors ? `, ${e.errors} failed` : ''}` : 'No requests since HttpDash started';
        path.appendChild(title);
        svg.appendChild(path);
      }
      canvas.appendChild(svg);
      for (const n of graph.nodes) {
        const p = pos[n.id];
        if (!p) continue;
        const el = h(`div.dg-node.dg-${n.kind}`, {
          class: [n.health === 'down' && 'dg-down', n.flags.includes('left') && 'dg-left', n.flags.includes('hidden') && 'dg-hidden', ui.dgSelected === n.id && 'selected', ...n.flags.map((f) => `dg-flagged-${f}`)].filter(Boolean).join(' '),
          style: { left: `${p.x}px`, top: `${p.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` },
          title: [n.label, n.detail].filter(Boolean).join('\n'),
          dataset: { id: n.id },
        },
        h('div.dg-head', h(`span.dg-dot.dg-${n.health}`), h('span.dg-label', n.label), h('span.dg-kind', KIND_LABEL[n.kind])),
        h('div.dg-detail', n.detail || ''),
        h('div.dg-foot', h('span.dg-stats', fmtStats(n)), ...n.flags.filter((f) => f !== 'hidden').map((f) => h(`span.dg-flag.dg-flag-${f}`, FLAG_LABEL[f] || f))));
        el.addEventListener('mousedown', (ev) => startDrag(ev, n.id));
        canvas.appendChild(el);
      }
      applyZoom();
      renderPanel();
    };

    // Dragging a node; a click without moving selects it.
    const startDrag = (ev, id) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const p = laid.pos[id];
      dragging = { id, x0: ev.clientX, y0: ev.clientY, px: p.x, py: p.y, moved: false };
      const move = (e) => {
        const dx = (e.clientX - dragging.x0) / ui.dgZoom;
        const dy = (e.clientY - dragging.y0) / ui.dgZoom;
        if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        dragging.moved = true;
        savedPositions(env.id)[id] = { x: Math.max(0, Math.round((dragging.px + dx) / 10) * 10), y: Math.max(0, Math.round((dragging.py + dy) / 10) * 10) };
        draw();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const wasMoved = dragging.moved;
        dragging = null;
        if (wasMoved) HD.save();
        else selectNode(ui.dgSelected === id ? null : id);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };

    const sourcesOf = () => HD.discoverySources().filter((src) => src.environmentId === env.id);
    let timer = null;
    let first = true;
    const refresh = async () => {
      clearTimeout(timer);
      if (!view.isConnected && !first) return; // the page was left
      if (!dragging && !document.hidden) {
        try {
          const tunnel = env.tunnelId && env.tunnelId !== 'auto' && env.tunnelId !== 'none' ? (HD.tunnels().find((t) => t.id === env.tunnelId) || null) : null;
          graph = await window.api.topology({
            environment: HD.clone({ id: env.id, name: env.name, values: env.values }),
            sources: HD.clone(sourcesOf()),
            tunnel: tunnel ? { id: tunnel.id, name: tunnel.name } : null,
            settings: { segmentBits4: S.ws.settings.segmentBits4, segmentBits6: S.ws.settings.segmentBits6 },
          });
          draw();
          if (first) { first = false; requestAnimationFrame(() => { if (laid && (laid.width > wrap.clientWidth || laid.height > wrap.clientHeight)) fit(); }); }
        } catch (e) {
          HD.clear(canvas).appendChild(h('div.empty-state.dg-empty', `Could not draw the diagram: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`));
        }
      }
      timer = setTimeout(refresh, REFRESH_MS);
    };
    refresh();
    return view;
  };
})();
