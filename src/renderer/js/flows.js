'use strict';

/*
 * Flows: requests orchestrated in a designer. Nodes (Start, Execute, Condition, End) are dragged on a
 * canvas and connected port to port; values flow from one node to the next as {{node.value}}. A run
 * shows each node's state live, and its results as tabs: the ones the End node defines (a part of a
 * response, shown as a table), the flow's values, and each request's response.
 * The engine is src/core/flow.js, run in the main process.
 */
(() => {
  const { h } = HD;
  const S = HD.S;
  HD.views = HD.views || {};

  const flows = () => (S.ws.flows = S.ws.flows || []);
  HD.flows = flows;
  const runs = new Map(); // flow id -> { running, states: { nodeId: state }, summary, error }
  let liveRun = null; // { flowId, onEvent }
  const listeners = new Map(); // tab id -> the open designer's live-update listener

  const NODE_W = 210;
  const GRID = 10;
  const snap = (v) => Math.round(v / GRID) * GRID;
  const TYPES = {
    start: { label: 'Start', icon: 'play', help: 'Where the flow begins. Inputs become {{name}} values.' },
    execute: { label: 'Execute', icon: 'upload', help: 'Sends a saved request. Its outputs become {{node.name}} values.' },
    condition: { label: 'Condition', icon: 'flow-condition', help: 'Goes on through "true" or "false", by comparing values.' },
    end: { label: 'End', icon: 'stop', help: 'Where the flow ends. Its result tabs show parts of responses as tables.' },
  };
  const OPS = ['equals', 'not equals', 'contains', 'not contains', 'greater than', 'less than', 'exists', 'not exists', 'matches'];
  const keyOf = (label, fallback) => String(label || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback;

  const newNode = (type, x, y, extra = {}) => ({ id: HD.uid(), type, label: TYPES[type].label, x, y, ...extra });

  HD.newFlow = () => {
    const start = newNode('start', 40, 120, { inputs: [] });
    const exec = newNode('execute', 320, 110, { label: 'Request', requestId: null, outputs: [] });
    const end = newNode('end', 600, 120, { tabs: [], outputs: [] });
    const f = {
      id: HD.uid(), name: 'New flow', environmentId: null, persist: true, nodes: [start, exec, end],
      edges: [{ id: HD.uid(), from: start.id, port: 'out', to: exec.id }, { id: HD.uid(), from: exec.id, port: 'out', to: end.id }], lastRun: null,
    };
    flows().push(f);
    HD.save();
    HD.renderSidebar();
    openFlow(f.id, { pin: true });
    return f;
  };

  const openFlow = (id, opts = {}) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'flow' && t.refId === id);
    if (existing) { if (opts.pin) HD.pinTab(existing); return HD.activateTab(existing.id); }
    return HD.addTab({ id: HD.uid(), kind: 'flow', refId: id, ui: {} }, opts);
  };
  HD.openFlow = openFlow;

  const deleteFlow = async (f) => {
    if (!(await HD.confirm('Delete flow', `Delete "${f.name}"?`, { danger: true, okLabel: 'Delete' }))) return;
    flows().splice(flows().indexOf(f), 1);
    S.ws.tabs.filter((t) => t.kind === 'flow' && t.refId === f.id).forEach((t) => HD.closeTab(t.id, true));
    HD.save();
    HD.renderSidebar();
  };

  // ---- Sidebar ---------------------------------------------------------------------------------

  HD.renderFlowsSidebar = (panel) => {
    panel.appendChild(h('div.side-toolbar', HD.button('', () => HD.newFlow(), { icon: 'plus', ghost: true, title: 'New flow' }), h('span.muted.small.side-hint', 'Request flows')));
    const list = h('div.tree');
    panel.appendChild(list);
    if (!flows().length) {
      list.appendChild(h('div.empty-state.small', h('div', 'No flows yet.'),
        h('div.muted', 'A flow sends requests in order, passes values between them and branches on conditions.'),
        HD.button('New flow', () => HD.newFlow(), { small: true, icon: 'plus' })));
      return;
    }
    const active = HD.currentTab();
    for (const f of flows()) {
      const run = runs.get(f.id);
      const state = run && run.running ? 'running' : f.lastRun ? (f.lastRun.status === 'passed' ? 'ok' : 'fail') : 'idle';
      list.appendChild(h('div.tree-row.env-row', {
        class: active && active.kind === 'flow' && active.refId === f.id ? 'active' : '',
        onclick: () => openFlow(f.id, { preview: true }),
        ondblclick: () => openFlow(f.id, { pin: true }),
        oncontextmenu: (e) => HD.menu(e, [
          { label: 'Run', onClick: () => { openFlow(f.id); runFlow(f); } },
          { label: 'Duplicate', onClick: () => { const c = HD.clone(f); c.id = HD.uid(); c.name = `${f.name} Copy`; c.lastRun = null; flows().push(c); HD.save(); HD.renderSidebar(); } },
          { separator: true },
          { label: 'Delete', danger: true, onClick: () => deleteFlow(f) },
        ]),
      }, h(`span.monitor-dot.${state}`, { title: state }), h('span.tree-name', f.name), h('span.muted.small', `${f.nodes.length} nodes`)));
    }
  };

  // ---- Running ---------------------------------------------------------------------------------

  // Every saved request, for the Execute node's picker: [id, "Collection / Folder / Name"].
  const requestOptions = () => {
    const out = [];
    for (const c of S.ws.collections) HD.walk(c.items, (it, parents) => { if (it.type === 'request' && it.request) out.push([it.id, [c.name, ...parents.map((p) => p.name), it.name].join(' / '), it]); });
    return out;
  };
  const stripItems = (n) => { const { items, ...rest } = n; return HD.clone(rest); };

  window.api.onFlowEvent((evt) => { if (liveRun) liveRun.onEvent(evt); });

  async function runFlow(f) {
    const run = runs.get(f.id);
    if (run && run.running) return;
    if (liveRun) { HD.toast('Another flow is running; stop it first.', 'warn'); return; }
    const env = S.ws.environments.find((e) => e.id === (f.environmentId || S.ws.activeEnvironmentId)) || null;
    const requests = {};
    const collections = {};
    for (const n of f.nodes.filter((x) => x.type === 'execute' && x.requestId)) {
      const found = HD.find(n.requestId);
      if (!found || found.node.type !== 'request') continue;
      requests[n.id] = {
        id: found.node.id, name: found.node.name, request: HD.clone(found.node.request), collectionId: found.collection.id,
        chain: [found.collection, ...found.parents].map(stripItems), collectionVariables: HD.listToObject(found.collection.variables),
      };
      collections[found.collection.id] = HD.clone(found.collection);
    }
    const before = { globals: HD.listToObject(S.ws.globals), environment: env ? HD.listToObject(env.values) : {} };
    const state = { running: true, states: {}, summary: null, error: null };
    runs.set(f.id, state);
    liveRun = {
      flowId: f.id,
      onEvent: (evt) => {
        if (evt.type === 'node-start') state.states[evt.nodeId] = 'running';
        else if (evt.type === 'node-done') state.states[evt.nodeId] = evt.result.state;
        else if (evt.type === 'console') HD.log(evt.level, `[${evt.name}] ${evt.message}`);
        HD.emit('flow-run', f.id);
      },
    };
    HD.emit('flow-run', f.id);
    HD.renderSidebar();
    try {
      const summary = await window.api.runFlow({
        flow: HD.clone(f), requests, collections, useCookies: true,
        scopes: { ...HD.clone(before), collection: {}, pools: HD.discoveryPools ? HD.discoveryPools(env) : null },
        settings: { ...S.ws.settings, tunnelId: HD.tunnelIdFor ? HD.tunnelIdFor(env) : undefined },
      });
      state.summary = summary;
      for (const [id, r] of Object.entries(summary.nodes)) state.states[id] = r.state;
      if (f.persist !== false) {
        let changed = HD.applyScope(S.ws.globals, before.globals, summary.scopes.globals);
        if (env) changed = HD.applyScope(env.values, before.environment, summary.scopes.environment) || changed;
        if (changed) { HD.emit('variables'); }
      }
      f.lastRun = { time: Date.now(), status: summary.status, duration: summary.duration };
      HD.toast(`${f.name}: ${summary.status === 'passed' ? 'passed' : summary.status} in ${HD.formatMs(summary.duration)}`, summary.status === 'passed' ? 'success' : 'warn');
    } catch (e) {
      state.error = HD.cleanErr(e);
      f.lastRun = { time: Date.now(), status: 'failed', duration: 0 };
      HD.toast(`${f.name}: ${state.error}`, 'error', 6000);
    } finally {
      state.running = false;
      liveRun = null;
      HD.save();
      HD.renderSidebar();
      HD.emit('flow-run', f.id);
    }
  }
  HD.runFlow = runFlow;

  // ---- The designer ----------------------------------------------------------------------------

  HD.views.flow = (tab, root) => {
    const f = flows().find((x) => x.id === tab.refId);
    if (!f) { root.appendChild(h('div.empty-state', 'This flow was deleted.')); return; }
    HD.variableInfo = () => HD.variableInfoFor(null);
    tab.ui = tab.ui || {};
    const touch = () => { HD.pinTab(tab); HD.save(); };
    let selected = tab.ui.selected || null; // { kind: 'node' | 'edge', id }
    const byId = (id) => f.nodes.find((n) => n.id === id);
    const keys = () => Object.fromEntries(f.nodes.map((n) => [n.id, keyOf(n.label, n.type)]));

    // -- Canvas
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'flow-edges');
    const canvas = h('div.flow-canvas', { tabindex: '0' });
    canvas.appendChild(svg);
    // The canvas is scaled for zoom; the sizer gives the scroll area its scaled size.
    const sizer = h('div.flow-sizer', canvas);
    const wrap = h('div.flow-canvas-wrap', sizer);
    let zoom = tab.ui.zoom || 1;
    const applyZoom = () => {
      canvas.style.transform = `scale(${zoom})`;
      sizer.style.width = `${parseFloat(canvas.style.width) * zoom}px`;
      sizer.style.height = `${parseFloat(canvas.style.height) * zoom}px`;
      if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };
    const setZoom = (z) => { zoom = Math.min(1.5, Math.max(0.3, Math.round(z * 100) / 100)); tab.ui.zoom = zoom; HD.save(); applyZoom(); };
    // Zooms so every node is in view (never larger than 100%).
    const fit = () => {
      const right = Math.max(...f.nodes.map((n) => n.x + NODE_W)) + 40;
      const bottom = Math.max(...f.nodes.map((n) => n.y + 160)) + 40;
      setZoom(Math.min(1, (wrap.clientWidth || 800) / right, (wrap.clientHeight || 400) / bottom));
      wrap.scrollLeft = 0; wrap.scrollTop = 0;
    };
    let zoomLabel = null;
    const inspector = h('div.flow-inspector');
    const results = h('div.flow-results');
    const nodeEls = new Map();

    const size = () => {
      const w = Math.max(1400, ...f.nodes.map((n) => n.x + NODE_W + 200));
      const hgt = Math.max(700, ...f.nodes.map((n) => n.y + 260));
      canvas.style.width = `${w}px`; canvas.style.height = `${hgt}px`;
      svg.setAttribute('width', w); svg.setAttribute('height', hgt);
      applyZoom();
    };
    // A port's centre on the canvas.
    const portPoint = (nodeId, port) => {
      const el = nodeEls.get(nodeId);
      if (!el) return null;
      const p = el.querySelector(`.flow-port[data-port="${port}"]`);
      if (!p) return null;
      return { x: el.offsetLeft + p.offsetLeft + p.offsetWidth / 2, y: el.offsetTop + p.offsetTop + p.offsetHeight / 2 };
    };
    const curve = (a, b) => {
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };
    const svgEl = (name, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const drawEdges = () => {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const run = runs.get(f.id);
      for (const e of f.edges) {
        const a = portPoint(e.from, e.port || 'out');
        const b = portPoint(e.to, 'in');
        if (!a || !b) continue;
        const d = curve(a, b);
        const fromState = run && run.states[e.from];
        const toState = run && run.states[e.to];
        const live = fromState && fromState !== 'skipped' && toState && toState !== 'skipped' && toState !== 'not run';
        const cls = ['flow-edge', e.port === 'true' && 'is-true', e.port === 'false' && 'is-false', selected && selected.kind === 'edge' && selected.id === e.id && 'selected', live && 'live'].filter(Boolean).join(' ');
        const hit = svgEl('path', { d, class: 'flow-edge-hit' });
        hit.addEventListener('mousedown', (ev) => { ev.stopPropagation(); select({ kind: 'edge', id: e.id }); });
        svg.append(svgEl('path', { d, class: cls }), hit);
      }
      if (drag && drag.kind === 'connect' && drag.to) svg.appendChild(svgEl('path', { d: curve(drag.from, drag.to), class: 'flow-edge drafting' }));
    };

    const summaryOf = (n) => {
      if (n.type === 'start') return (n.inputs || []).filter((i) => i.key).map((i) => `{{${i.key}}}`).join(' ') || 'No inputs';
      if (n.type === 'execute') {
        const found = n.requestId && HD.find(n.requestId);
        if (!found) return h('span.text-error', 'Choose a request');
        return [h(`span.method-tag.${HD.methodClass(found.node.request.method)}`, found.node.request.method.slice(0, 6)), ` ${found.node.name}`];
      }
      if (n.type === 'condition') return (n.rules || []).length ? (n.rules || []).map((r) => `${r.left} ${r.op} ${r.op.includes('exists') ? '' : r.right}`).join(n.match === 'any' ? ' or ' : ' and ') : 'Always true';
      if (n.type === 'end') return (n.tabs || []).length ? `${(n.tabs || []).length} result tab${n.tabs.length === 1 ? '' : 's'}` : 'No result tabs';
      return '';
    };
    const drawNodes = () => {
      for (const el of nodeEls.values()) el.remove();
      nodeEls.clear();
      const run = runs.get(f.id);
      const k = keys();
      for (const n of f.nodes) {
        const st = run && run.states[n.id];
        const outPorts = n.type === 'condition' ? [['true', 'true'], ['false', 'false']] : n.type === 'end' ? [] : [['out', '']];
        const el = h(`div.flow-node.type-${n.type}`, {
          class: [selected && selected.kind === 'node' && selected.id === n.id && 'selected', st && `state-${st.replace(' ', '-')}`].filter(Boolean).join(' '),
          style: { left: `${n.x}px`, top: `${n.y}px`, width: `${NODE_W}px` }, dataset: { id: n.id },
        },
        n.type !== 'start' ? h('span.flow-port.in', { dataset: { port: 'in' }, title: 'Input' }) : null,
        h('div.flow-node-head', HD.icon(TYPES[n.type].icon), h('span.flow-node-label', n.label || TYPES[n.type].label),
          n.type !== 'start' && n.type !== 'end' ? h('span.flow-node-key', k[n.id]) : null,
          st ? h(`span.flow-node-state.state-${st.replace(' ', '-')}`, st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'running' ? '…' : st === 'skipped' ? '–' : '') : null),
        h('div.flow-node-body', summaryOf(n)),
        outPorts.length ? h('div.flow-node-outs', outPorts.map(([port, label]) => h('span.flow-out', label ? h('span.flow-out-label', label) : null,
          h(`span.flow-port.out.port-${port}`, { dataset: { port }, title: label ? `Goes on here when ${label}` : 'Output: drag to another node' })))) : null);
        el.addEventListener('mousedown', (ev) => onNodeDown(ev, n));
        canvas.appendChild(el);
        nodeEls.set(n.id, el);
      }
      size();
      drawEdges();
    };

    // -- Dragging nodes and connections
    let drag = null;
    const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom }; };
    function onNodeDown(ev, n) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const port = ev.target.closest('.flow-port.out');
      if (port) {
        ev.preventDefault();
        drag = { kind: 'connect', node: n, port: port.dataset.port, from: portPoint(n.id, port.dataset.port), to: pointer(ev) };
      } else {
        if (ev.target.closest('input, select, textarea, button')) return;
        const p = pointer(ev);
        drag = { kind: 'move', node: n, dx: p.x - n.x, dy: p.y - n.y, moved: false };
        select({ kind: 'node', id: n.id }, { keepCanvas: true });
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    }
    function onMove(ev) {
      if (!drag) return;
      const p = pointer(ev);
      if (drag.kind === 'move') {
        drag.node.x = Math.max(0, snap(p.x - drag.dx));
        drag.node.y = Math.max(0, snap(p.y - drag.dy));
        drag.moved = true;
        const el = nodeEls.get(drag.node.id);
        el.style.left = `${drag.node.x}px`; el.style.top = `${drag.node.y}px`;
        size();
      } else {
        drag.to = p;
        const over = document.elementFromPoint(ev.clientX, ev.clientY);
        canvas.querySelectorAll('.flow-node.drop-target').forEach((x) => x.classList.remove('drop-target'));
        const target = over && over.closest('.flow-node');
        if (target && target.dataset.id !== drag.node.id && byId(target.dataset.id).type !== 'start') target.classList.add('drop-target');
      }
      drawEdges();
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      const d = drag;
      drag = null;
      canvas.querySelectorAll('.flow-node.drop-target').forEach((x) => x.classList.remove('drop-target'));
      if (!d) return;
      if (d.kind === 'move') { if (d.moved) touch(); drawEdges(); return; }
      // A connection dropped on a node (its input port or anywhere on it).
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = over && over.closest('.flow-node');
      const to = target && byId(target.dataset.id);
      if (to && to.id !== d.node.id && to.type !== 'start' && !f.edges.some((e) => e.from === d.node.id && (e.port || 'out') === d.port && e.to === to.id)) {
        // One connection per output port: a new one replaces it, which is how it's moved.
        f.edges = f.edges.filter((e) => !(e.from === d.node.id && (e.port || 'out') === d.port && d.node.type === 'condition'));
        f.edges.push({ id: HD.uid(), from: d.node.id, port: d.port, to: to.id });
        touch();
      }
      drawEdges();
    }
    canvas.addEventListener('mousedown', (ev) => { if (ev.target === canvas || ev.target === svg) select(null); });
    canvas.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && !ev.target.closest('input, textarea, select')) { ev.preventDefault(); removeSelected(); }
    });

    const removeSelected = () => {
      if (!selected) return;
      if (selected.kind === 'edge') f.edges = f.edges.filter((e) => e.id !== selected.id);
      else {
        const n = byId(selected.id);
        if (!n || n.type === 'start') { HD.toast('A flow keeps its Start node.', 'info'); return; }
        f.nodes = f.nodes.filter((x) => x.id !== n.id);
        f.edges = f.edges.filter((e) => e.from !== n.id && e.to !== n.id);
        for (const end of f.nodes.filter((x) => x.type === 'end')) end.tabs = (end.tabs || []).filter((t) => t.node !== n.id);
      }
      selected = null;
      tab.ui.selected = null;
      touch();
      drawNodes();
      drawInspector();
    };

    function select(sel, { keepCanvas = false } = {}) {
      selected = sel;
      tab.ui.selected = sel;
      canvas.querySelectorAll('.flow-node').forEach((el) => el.classList.toggle('selected', !!(sel && sel.kind === 'node' && el.dataset.id === sel.id)));
      drawEdges();
      drawInspector();
      if (!keepCanvas || document.activeElement === document.body) canvas.focus({ preventScroll: true });
    }

    // Adds a node to the right of the selected one (connected to it when it has a free output), or in view.
    const addNode = (type) => {
      const from = selected && selected.kind === 'node' ? byId(selected.id) : null;
      const x = from ? from.x + NODE_W + 70 : snap(wrap.scrollLeft + 80);
      const y = from ? from.y : snap(wrap.scrollTop + 80);
      const extra = type === 'execute' ? { label: 'Request', requestId: null, outputs: [] } : type === 'condition' ? { rules: [{ left: '', op: 'equals', right: '' }], match: 'all' } : { tabs: [], outputs: [] };
      const n = newNode(type, x, y, extra);
      f.nodes.push(n);
      if (from && from.type !== 'end') {
        const port = from.type === 'condition' ? (f.edges.some((e) => e.from === from.id && e.port === 'true') ? 'false' : 'true') : 'out';
        if (from.type !== 'condition' || !f.edges.some((e) => e.from === from.id && e.port === port)) f.edges.push({ id: HD.uid(), from: from.id, port, to: n.id });
      }
      touch();
      drawNodes();
      select({ kind: 'node', id: n.id });
    };

    // -- Inspector
    const values = () => {
      // The {{values}} the flow makes, for hints: Start's inputs and each Execute node's outputs.
      const k = keys();
      const out = [];
      for (const n of f.nodes) {
        if (n.type === 'start') for (const i of n.inputs || []) if (i.key) out.push(`{{${i.key}}}`);
        if (n.type === 'execute') out.push(`{{${k[n.id]}.status}}`, ...(n.outputs || []).filter((o) => o.name).map((o) => `{{${k[n.id]}.${o.name}}}`));
      }
      return out;
    };
    const valueChips = () => {
      const list = values();
      return list.length ? h('div.flow-values', h('span.muted.small', 'Values: '), list.map((v) => h('button.flow-value', { type: 'button', title: 'Copy', onclick: () => { navigator.clipboard.writeText(v); HD.toast(`Copied ${v}`, 'info', 1500); } }, v))) : null;
    };
    const input = (value, placeholder, onInput, cls = '') => h(`input.input${cls ? `.${cls}` : ''}`, { value: value == null ? '' : value, placeholder, spellcheck: 'false', oninput: (e) => { onInput(e.target.value); touch(); refreshNode(); } });
    const removeBtn = (onClick) => HD.button('', onClick, { icon: 'x', ghost: true, small: true, title: 'Remove' });
    // Rows of fields: list is changed in place.
    const rows = (list, make, blank, addLabel) => {
      const box = h('div.flow-rows');
      const draw = () => {
        HD.clear(box);
        list.forEach((r, i) => box.appendChild(h('div.flow-row', ...make(r), removeBtn(() => { list.splice(i, 1); touch(); draw(); refreshNode(); }))));
        box.appendChild(HD.button(addLabel, () => { list.push(blank()); touch(); draw(); refreshNode(); }, { small: true, ghost: true, icon: 'plus' }));
      };
      draw();
      return box;
    };
    const refreshNode = HD.debounce(() => { drawNodes(); }, 120);

    function drawInspector() {
      HD.clear(inspector);
      if (!selected) {
        inspector.append(h('div.section-title', 'Flow'),
          h('label.field', h('span', 'Name'), input(f.name, 'Flow name', (v) => { f.name = v; HD.renderSidebar(); HD.renderTabBar(); })),
          h('label.field', h('span', 'Environment'), HD.select([['', 'The active environment'], ...S.ws.environments.map((e) => [e.id, e.name])], f.environmentId || '', (v) => { f.environmentId = v || null; touch(); })),
          h('label.check', h('input', { type: 'checkbox', checked: f.persist !== false, onchange: (e) => { f.persist = e.target.checked; touch(); } }), 'Keep variable changes made during the run (such as refreshed tokens)'),
          h('div.muted.small.flow-help', 'Drag a node by its title. Drag from a node\'s right-hand dot to another node to connect them. Click a connection or a node and press Delete to remove it. Nodes run once everything before them has run; the branch a condition doesn\'t take is skipped.'));
        return;
      }
      if (selected.kind === 'edge') {
        const e = f.edges.find((x) => x.id === selected.id);
        if (!e) return;
        inspector.append(h('div.section-title', 'Connection'),
          h('div', `${(byId(e.from) || {}).label} ${e.port && e.port !== 'out' ? `(${e.port}) ` : ''}→ ${(byId(e.to) || {}).label}`),
          h('div.button-row', HD.button('Delete connection', removeSelected, { danger: true, small: true, icon: 'trash' })));
        return;
      }
      const n = byId(selected.id);
      if (!n) return;
      const k = keys();
      inspector.append(h('div.section-title', TYPES[n.type].label), h('div.muted.small.flow-help', TYPES[n.type].help),
        h('label.field', h('span', 'Label'), input(n.label, TYPES[n.type].label, (v) => { n.label = v; }),
          n.type === 'execute' ? h('span.field-help', `Values from it are {{${k[n.id]}.…}}.`) : null));
      if (n.type === 'start') {
        n.inputs = n.inputs || [];
        inspector.append(h('div.section-title', 'Inputs'), h('div.muted.small', 'Values the flow starts with, used as {{name}}. Variables are allowed.'),
          rows(n.inputs, (r) => [input(r.key, 'name', (v) => { r.key = v; }), input(r.value, 'value', (v) => { r.value = v; })], () => ({ key: '', value: '' }), 'Add input'));
      } else if (n.type === 'execute') {
        n.outputs = n.outputs || [];
        const opts = requestOptions();
        const found = n.requestId && HD.find(n.requestId);
        inspector.append(
          h('label.field', h('span', 'Request'), HD.select([['', 'Choose a saved request…'], ...opts.map(([id, label]) => [id, label])], n.requestId || '', (v) => {
            n.requestId = v || null;
            const it = opts.find((o) => o[0] === v);
            if (it && (!n.label || n.label === 'Request' || n.label === TYPES.execute.label)) n.label = it[2].name;
            touch(); drawNodes(); drawInspector();
          })),
          found ? h('div.button-row', HD.button('Open request', () => HD.openRequest(n.requestId, { pin: true }), { small: true, ghost: true })) : null,
          h('div.section-title', 'Outputs'),
          h('div.muted.small', h('span', 'Values taken from the response, used by later nodes as '), h('code', `{{${k[n.id]}.name}}`), h('span', '. A path is status, time, headers.Name or a path in the JSON body (data.token, items[0].id).')),
          rows(n.outputs, (r) => [input(r.name, 'name', (v) => { r.name = v; }), input(r.path, 'path, e.g. data.token', (v) => { r.path = v; })], () => ({ name: '', path: '' }), 'Add output'),
          h('label.check', h('input', { type: 'checkbox', checked: !!n.continueOnError, onchange: (e) => { n.continueOnError = e.target.checked; touch(); } }), 'Carry on when the request fails'),
          valueChips());
      } else if (n.type === 'condition') {
        n.rules = n.rules || [];
        inspector.append(
          h('label.field', h('span', 'Goes through "true" when'), HD.select([['all', 'All rules match'], ['any', 'Any rule matches']], n.match || 'all', (v) => { n.match = v; touch(); refreshNode(); })),
          rows(n.rules, (r) => [input(r.left, '{{login.status}}', (v) => { r.left = v; }), HD.select(OPS.map((o) => [o, o]), r.op || 'equals', (v) => { r.op = v; touch(); refreshNode(); }), input(r.right, 'value', (v) => { r.right = v; })],
            () => ({ left: '', op: 'equals', right: '' }), 'Add rule'),
          valueChips());
      } else if (n.type === 'end') {
        n.tabs = n.tabs || [];
        n.outputs = n.outputs || [];
        const sources = f.nodes.filter((x) => x.type === 'execute' || x.type === 'start');
        inspector.append(h('div.section-title', 'Result tabs'),
          h('div.muted.small', 'Each tab shows part of a node\'s response as a table: pick the node and the path to the leaf to show (data.items). Empty path: the whole response.'),
          rows(n.tabs, (r) => [input(r.name, 'tab name', (v) => { r.name = v; }),
            HD.select([['', 'Node…'], ...sources.map((x) => [x.id, x.label || x.type])], r.node || '', (v) => { r.node = v || null; touch(); refreshNode(); }),
            input(r.path, 'path, e.g. data.items', (v) => { r.path = v; })], () => ({ name: '', node: null, path: '' }), 'Add result tab'),
          h('div.section-title', 'Outputs'),
          h('div.muted.small', 'Named results of the flow, with {{values}}.'),
          rows(n.outputs, (r) => [input(r.name, 'name', (v) => { r.name = v; }), input(r.value, '{{orders.total}}', (v) => { r.value = v; })], () => ({ name: '', value: '' }), 'Add output'),
          valueChips());
      }
      if (n.type !== 'start') inspector.appendChild(h('div.button-row.flow-danger', HD.button('Delete node', removeSelected, { danger: true, small: true, icon: 'trash' })));
    }

    // -- Results
    function drawResults() {
      HD.clear(results);
      const run = runs.get(f.id);
      if (!run || (!run.summary && !run.error && !run.running)) {
        results.appendChild(h('div.empty-state.small', h('div', 'Run the flow to see its results here.'), h('div.muted', 'The End node\'s result tabs come first, then the flow\'s values and each request\'s response.')));
        return;
      }
      if (run.error) { results.appendChild(h('div.test-script-error', run.error)); return; }
      if (!run.summary) { results.appendChild(h('div.runner-progress', h('div.spinner.small'), 'Running…')); return; }
      const sum = run.summary;
      const tabs = [];
      for (const endId of sum.ends) for (const [i, t] of (sum.nodes[endId].tabs || []).entries()) tabs.push({ id: `tab:${endId}:${i}`, label: t.name, render: (area) => (t.missing && t.value == null ? area.appendChild(h('div.muted.flow-missing', t.missing)) : HD.renderJsonTable(area, t.value)) });
      const endOutputs = Object.assign({}, ...sum.ends.map((id) => sum.nodes[id].outputs || {}));
      if (Object.keys(endOutputs).length) tabs.push({ id: 'outputs', label: 'Outputs', render: (area) => HD.renderJsonTable(area, endOutputs) });
      tabs.push({ id: 'values', label: 'Values', render: (area) => HD.renderJsonTable(area, sum.values) });
      for (const id of sum.order) {
        const r = sum.nodes[id];
        if (r.type !== 'execute' && r.type !== 'condition') continue;
        tabs.push({
          id: `node:${id}`, label: r.label, state: r.state,
          render: (area) => {
            if (r.type === 'condition') {
              area.appendChild(h('div.flow-node-result', h('span', `Went through "${r.branch}"`)));
              HD.renderJsonTable(area, r.checks.map((c) => ({ value: c.left, rule: c.op, compared_with: c.right, matched: c.passed })));
              return;
            }
            const res = r.response;
            area.appendChild(h('div.flow-node-result',
              res ? h(`span.${HD.statusClass(res.status)}`, `${res.status} ${res.statusText || ''}`) : null,
              res ? h('span.muted', HD.formatMs(res.time)) : null,
              r.error ? h('span.text-error', r.error) : null,
              r.tests && r.tests.length ? h('span.muted', `${r.tests.filter((t) => t.passed && !t.skipped).length}/${r.tests.length} tests passed`) : null,
              r.sentRequest ? h('span.muted.mono.small', `${r.sentRequest.method} ${r.sentRequest.url}`) : null));
            if (!res) return;
            let json;
            try { json = JSON.parse(res.bodyText); } catch { json = undefined; }
            if (json !== undefined) HD.renderJsonTable(area, json);
            else area.appendChild(h('pre.flow-raw', res.bodyText || ''));
          },
        });
      }
      const current = tabs.find((t) => t.id === tab.ui.resultTab) || tabs[0];
      results.append(
        h('div.flow-results-head', h('span', { class: `pill ${sum.status === 'passed' ? 'added' : 'removed'}` }, sum.status), h('span.muted.small', `${sum.order.length} nodes ran in ${HD.formatMs(sum.duration)}`)),
        h('div.subtabs.flow-result-tabs', tabs.map((t) => h('button', {
          type: 'button', class: ['subtab', t.id === current.id && 'active', t.state && `state-${t.state.replace(' ', '-')}`].filter(Boolean).join(' '),
          onclick: () => { tab.ui.resultTab = t.id; HD.save(); drawResults(); },
        }, t.label))));
      const area = h('div.flow-result-area');
      results.appendChild(area);
      current.render(area);
    }

    // -- Toolbar
    const run = runs.get(f.id);
    const toolbar = h('div.flow-toolbar',
      h('span.flow-title', HD.icon('flow'), f.name),
      h('span.flow-add', h('span.muted.small', 'Add'),
        ...['execute', 'condition', 'end'].map((t) => HD.button(TYPES[t].label, () => addNode(t), { small: true, icon: TYPES[t].icon, title: `Add a ${TYPES[t].label} node${selected ? ' after the selected one' : ''}` }))),
      h('span.spacer'),
      h('span.flow-zoom',
        HD.button('', () => setZoom(zoom - 0.1), { icon: 'minus', ghost: true, small: true, title: 'Zoom out' }),
        (zoomLabel = h('span.muted.small.flow-zoom-label', `${Math.round(zoom * 100)}%`)),
        HD.button('', () => setZoom(zoom + 0.1), { icon: 'plus', ghost: true, small: true, title: 'Zoom in' }),
        HD.button('Fit', fit, { ghost: true, small: true, title: 'Zoom to show the whole flow' })),
      run && run.running ? HD.button('Stop', () => window.api.stopFlow(), { danger: true, icon: 'stop' }) : HD.button('Run flow', () => runFlow(f), { primary: true, icon: 'play' }));

    root.appendChild(h('div.flow-view', toolbar, h('div.flow-main', wrap, inspector), results));
    drawNodes();
    drawInspector();
    drawResults();
    // The first time a flow is opened, it is zoomed to fit.
    if (!tab.ui.zoom) requestAnimationFrame(fit);
    wrap.addEventListener('wheel', (ev) => { if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); setZoom(zoom - Math.sign(ev.deltaY) * 0.1); } }, { passive: false });

    // Live updates while it runs (only while this view is on screen).
    const onRun = (id) => {
      if (id !== f.id || !document.body.contains(canvas)) return;
      drawNodes();
      drawResults();
      const r = runs.get(f.id);
      const btnHost = toolbar.lastChild;
      const btn = r && r.running ? HD.button('Stop', () => window.api.stopFlow(), { danger: true, icon: 'stop' }) : HD.button('Run flow', () => runFlow(f), { primary: true, icon: 'play' });
      btnHost.replaceWith(btn);
    };
    // One listener per tab, kept outside the tab (tabs are saved with the workspace).
    HD.off('flow-run', listeners.get(tab.id));
    listeners.set(tab.id, onRun);
    HD.on('flow-run', onRun);
  };
})();
