'use strict';

/**
 * Flows: requests orchestrated as a graph of nodes, drawn in the flow designer.
 *
 * flow: {
 *   nodes: [{ id, type: 'start' | 'execute' | 'condition' | 'end', label, ... }],
 *   edges: [{ id, from, port: 'out' | 'true' | 'false', to }],
 * }
 *   start      inputs: [{ key, value }]: values the flow starts with, used as {{key}}
 *   execute    requestId: a saved request. outputs: [{ name, path }]: values taken from its response
 *              and passed on as {{<node key>.<name>}}. A path is "status", "time", "headers.<name>"
 *              or a path into the JSON body ("data.token", "body.items[0].id"). {{<key>.status}}
 *              and {{<key>.time}} are always there. continueOnError: carry on when the request fails.
 *   condition  rules: [{ left, op, right }] with {{values}}, match: 'all' | 'any'. Goes on through
 *              its "true" or its "false" port.
 *   end        outputs: [{ name, value }]: the flow's results, with {{values}}.
 *              tabs: [{ name, node, path }]: result tabs, each the part of a node's response at a path
 *              (empty: the whole JSON body), kept as JSON so it can be shown as a table.
 *
 * A node runs once everything before it has run or been skipped, and at least one connection into
 * it was taken. A node none of whose connections were taken (the other side of a condition) is
 * skipped, and so is what follows only from it. The graph can't have cycles.
 *
 * Every request in a run shares the variable scopes (as in the Runner), so a script that sets an
 * environment variable is seen by the requests after it; the flow's values sit on top, like data
 * from a data file.
 */
const variables = require('./variables');
const { getPath } = require('./dependency');

class FlowError extends Error {}

const OPS = {
  equals: (a, b) => (isNum(a) && isNum(b) ? Number(a) === Number(b) : String(a) === String(b)),
  'not equals': (a, b) => !OPS.equals(a, b),
  contains: (a, b) => String(a).includes(String(b)),
  'not contains': (a, b) => !String(a).includes(String(b)),
  'greater than': (a, b) => Number(a) > Number(b),
  'less than': (a, b) => Number(a) < Number(b),
  exists: (a) => a !== undefined && a !== '' && !/^\{\{[^{}]+\}\}$/.test(String(a)),
  'not exists': (a) => !OPS.exists(a),
  matches: (a, b) => { try { return new RegExp(b).test(String(a)); } catch { return false; } },
};
const isNum = (v) => v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v));

/** A node's key in {{key.name}}: its label in lower_snake_case, made unique in the flow. */
function nodeKeys(flow) {
  const keys = {};
  const used = new Set();
  for (const n of flow.nodes) {
    const base = String(n.label || n.type).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || n.type;
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
    used.add(key);
    keys[n.id] = key;
  }
  return keys;
}

/** Problems that stop a flow from running, as sentences (empty when it can run). */
function validate(flow) {
  const problems = [];
  const nodes = new Map((flow.nodes || []).map((n) => [n.id, n]));
  const starts = flow.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) problems.push(starts.length ? 'A flow has one Start node.' : 'Add a Start node.');
  for (const e of flow.edges || []) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) problems.push('A connection points at a node that is gone.');
    else if (nodes.get(e.to).type === 'start') problems.push('Nothing can connect into Start.');
  }
  for (const n of flow.nodes) {
    if (n.type === 'execute' && !n.requestId) problems.push(`"${n.label || 'Execute'}" has no request chosen.`);
  }
  // Cycles: a node that can be reached from itself.
  const out = new Map();
  for (const e of flow.edges || []) out.set(e.from, [...(out.get(e.from) || []), e.to]);
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) || []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  if (flow.nodes.some((n) => visit(n.id))) problems.push('The flow goes round in a loop; loops are not supported.');
  return [...new Set(problems)];
}

// A value from a response: "status", "time", "headers.<name>" or a path into the JSON body.
function outputValue(path, res) {
  const p = String(path || '').trim();
  const r = res.response;
  if (!r) return undefined;
  if (p === 'status') return r.status;
  if (p === 'time') return r.time;
  if (p.toLowerCase().startsWith('headers.')) {
    const name = p.slice(8).toLowerCase();
    const found = Object.entries(r.headers || {}).find(([k]) => k.toLowerCase() === name);
    return found ? found[1] : undefined;
  }
  let json;
  try { json = JSON.parse(r.bodyText); } catch { return undefined; }
  if (!p || p === 'body') return json;
  return getPath(json, p.replace(/^body\./, ''));
}
const asText = (v) => (v === undefined ? '' : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Runs a flow.
 * opts: {
 *   flow, requests: { [nodeId]: { request, chain, lookup?, collectionVariables? } } for the execute nodes
 *     (a flow can use requests from several collections; each sees its own collection's variables),
 *   scopes: { globals, environment, collection, pools }, settings, jar, signal,
 *   onEvent(evt): { type: 'node-start' | 'node-done' | 'done', ... },
 *   execute: the executor (executor.execute; replaceable in tests), makeScriptSession,
 * }
 * Returns { status: 'passed' | 'failed' | 'stopped', values, nodes: { [id]: result }, order, ends, duration }.
 */
async function run(opts) {
  const { flow } = opts;
  const problems = validate(flow);
  if (problems.length) throw new FlowError(problems.join(' '));
  const execute = opts.execute || require('./executor').execute;
  const emit = opts.onEvent || (() => {});
  const keys = nodeKeys(flow);
  const scopes = { globals: { ...(opts.scopes.globals || {}) }, environment: { ...(opts.scopes.environment || {}) }, collection: { ...(opts.scopes.collection || {}) } };
  const values = {};
  const results = {};
  const order = [];
  const ends = [];
  const started = Date.now();
  let status = 'passed';
  let stopped = false; // a failed request ended the flow
  const session = opts.makeScriptSession ? opts.makeScriptSession() : null;

  const incoming = new Map(flow.nodes.map((n) => [n.id, []]));
  for (const e of flow.edges) incoming.get(e.to).push(e);
  const taken = new Set(); // edges a finished node went on through
  const state = new Map(); // id -> 'done' | 'skipped' | 'failed'
  const resolveText = (text) => variables.resolve(String(text == null ? '' : text), { ...variables.mergeScopes({ ...scopes, data: values }) });

  const finish = (node, result) => {
    results[node.id] = { key: keys[node.id], type: node.type, label: node.label, ...result };
    state.set(node.id, result.state);
    if (result.state !== 'skipped') order.push(node.id);
    emit({ type: 'node-done', nodeId: node.id, result: results[node.id] });
  };
  const goOn = (node, port) => { for (const e of flow.edges) if (e.from === node.id && (!port || e.port === port || (!e.port && port === 'out'))) taken.add(e.id); };

  try {
    for (let guard = 0; guard <= flow.nodes.length; guard++) {
      if (opts.signal && opts.signal.aborted) { status = 'stopped'; break; }
      // Nodes whose every predecessor is settled.
      const ready = flow.nodes.filter((n) => !state.has(n.id) && incoming.get(n.id).every((e) => state.has(e.from)));
      if (!ready.length) break;
      for (const node of ready) {
        if (opts.signal && opts.signal.aborted) { status = 'stopped'; break; }
        const into = incoming.get(node.id);
        if (node.type !== 'start' && !into.some((e) => taken.has(e.id))) { finish(node, { state: 'skipped' }); continue; }
        emit({ type: 'node-start', nodeId: node.id });
        const t0 = Date.now();
        if (node.type === 'start') {
          for (const i of node.inputs || []) if (i.key) values[i.key] = resolveText(i.value);
          finish(node, { state: 'done', outputs: Object.fromEntries((node.inputs || []).filter((i) => i.key).map((i) => [i.key, values[i.key]])) });
          goOn(node, 'out');
        } else if (node.type === 'execute') {
          const def = opts.requests[node.id];
          if (!def) throw new FlowError(`The request for "${node.label}" is gone.`);
          const res = await execute({
            request: def.request, chain: def.chain || [], lookup: def.lookup, settings: opts.settings, jar: opts.jar, signal: opts.signal,
            scopes: { ...scopes, ...(def.collectionVariables ? { collection: { ...def.collectionVariables } } : {}), data: { ...values }, pools: opts.scopes.pools || null },
            info: { requestName: def.name || node.label, requestId: def.id || node.requestId, iteration: 0, iterationCount: 1 },
            log: (level, message) => emit({ type: 'console', level, message, name: node.label }),
            ...(session ? { scriptSession: session } : {}),
          });
          for (const k of ['globals', 'environment', ...(def.collectionVariables ? [] : ['collection'])]) if (res.scopes && res.scopes[k]) scopes[k] = res.scopes[k];
          const outputs = {};
          if (res.response) {
            values[`${keys[node.id]}.status`] = String(res.response.status);
            values[`${keys[node.id]}.time`] = String(res.response.time);
            for (const o of node.outputs || []) {
              if (!o.name) continue;
              outputs[o.name] = outputValue(o.path, res);
              values[`${keys[node.id]}.${o.name}`] = asText(outputs[o.name]);
            }
          }
          const failedTests = (res.tests || []).filter((t) => !t.passed && !t.skipped).length;
          const failed = !!res.error;
          finish(node, {
            state: failed ? 'failed' : 'done', time: Date.now() - t0, error: res.error || null, outputs, tests: res.tests || [], failedTests,
            sentRequest: res.sentRequest || null,
            response: res.response ? { status: res.response.status, statusText: res.response.statusText, time: res.response.time, size: res.response.size, headers: res.response.headers, bodyText: truncate(res.response.bodyText) } : null,
          });
          if (failed || failedTests) status = 'failed';
          if (failed && !node.continueOnError) { stopped = true; break; }
          goOn(node, 'out');
        } else if (node.type === 'condition') {
          const checks = (node.rules || []).map((r) => {
            const left = resolveText(r.left);
            const right = resolveText(r.right);
            const op = OPS[r.op] ? r.op : 'equals';
            return { left, op, right, passed: !!OPS[op](left, right) };
          });
          const ok = !checks.length || (node.match === 'any' ? checks.some((c) => c.passed) : checks.every((c) => c.passed));
          finish(node, { state: 'done', time: Date.now() - t0, branch: ok ? 'true' : 'false', checks });
          goOn(node, ok ? 'true' : 'false');
        } else if (node.type === 'end') {
          const outputs = Object.fromEntries((node.outputs || []).filter((o) => o.name).map((o) => [o.name, resolveText(o.value)]));
          const tabs = (node.tabs || []).filter((t) => t.node).map((t) => {
            const from = results[t.node];
            const name = t.name || `${from ? from.label : 'Result'}${t.path ? ` · ${t.path}` : ''}`;
            if (!from || from.state === 'skipped') return { name, node: t.node, path: t.path || '', missing: 'That node did not run.' };
            const value = from.type === 'start' ? (t.path ? getPath(from.outputs, t.path) : from.outputs) : outputValue(t.path || 'body', from);
            return { name, node: t.node, path: t.path || '', value: value === undefined ? null : value, ...(value === undefined ? { missing: `Nothing at "${t.path}".` } : {}) };
          });
          finish(node, { state: 'done', outputs, tabs });
          ends.push(node.id);
        } else {
          finish(node, { state: 'done' });
          goOn(node, 'out');
        }
      }
      if (stopped) break;
    }
  } finally {
    if (session) session.dispose();
  }
  // A failed request that stops the flow leaves the rest unrun.
  for (const n of flow.nodes) if (!state.has(n.id)) results[n.id] = { key: keys[n.id], type: n.type, label: n.label, state: status === 'stopped' ? 'stopped' : 'not run' };
  const summary = { status, values, nodes: results, order, ends, duration: Date.now() - started, scopes };
  emit({ type: 'done', summary: { ...summary, nodes: undefined } });
  return summary;
}

function truncate(s, n = 200000) {
  if (s == null) return s;
  return s.length > n ? `${s.slice(0, n)}\n... [truncated ${s.length - n} characters]` : s;
}

module.exports = { run, validate, nodeKeys, outputValue, OPS: Object.keys(OPS), FlowError };
