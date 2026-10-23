'use strict';

/**
 * The environment diagram: what an environment's requests go to, drawn from what HttpDash knows
 * without an agent in the services: the registry (service discovery), the environment's URL
 * variables, DNS, and the traffic sent since the app started.
 *
 *   this computer -> [tunnel] -> service endpoint ({{orders_url}}) -> [load balancer] -> instances
 *
 * Instances are grouped into network clusters: a Kubernetes namespace, a Consul datacenter or a
 * Eureka zone, and the network segment their addresses are on.
 *
 * build() returns { nodes, edges, groups }:
 *   node:  { id, kind: 'client'|'tunnel'|'endpoint'|'balancer'|'instance', label, detail, group?,
 *            health: 'ok'|'down'|'unknown', flags: ['slow'|'failing'|'left'|'unhealthy'|'hidden'],
 *            stats?: { requests, errors, p50, p95, share }, meta: { … for the details panel } }
 *   edge:  { from, to, requests, share, state: 'ok'|'errors'|'idle' }
 *   group: { id, label, cluster, segment, kind (of the addresses: private, public…) }
 */
const network = require('./network');

const URL_VALUE = /^(https?|wss?|grpcs?):\/\/[^\s{}]+$/i;
const MIN_REQUESTS = 5; // fewer than this says nothing about an instance being slow or failing

const BALANCE_LABEL = { 'round-robin': 'each instance in turn', random: 'a random instance', first: 'the first healthy instance' };
const BALANCE_SHORT = { 'round-robin': 'round robin', random: 'random', first: 'first healthy' };

function hostOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, display: u.host };
  } catch { return null; }
}

// Totals for the traffic rows of one instance (one row per instance and backend that answered).
function totals(rows) {
  if (!rows.length) return null;
  const requests = rows.reduce((n, r) => n + r.requests, 0);
  const failed = rows.reduce((n, r) => n + (r.errors || 0) + ((r.status && r.status['5xx']) || 0), 0);
  const weighted = (k) => Math.round(rows.reduce((n, r) => n + (r[k] || 0) * r.requests, 0) / Math.max(1, requests));
  return { requests, errors: failed, p50: weighted('p50'), p95: weighted('p95') };
}

// Slow and failing as the Traffic page judges them: compared with the instance's siblings.
function flagTraffic(nodes) {
  const busy = nodes.filter((n) => n.stats && n.stats.requests >= MIN_REQUESTS);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const p95s = busy.map((n) => n.stats.p95);
  for (const n of busy) {
    if (n.stats.errors / n.stats.requests >= 0.2) n.flags.push('failing');
    const others = median(p95s.filter((_, i) => busy[i] !== n));
    if (busy.length > 1 && n.stats.p95 >= 2 * others && n.stats.p95 - others >= 50) n.flags.push('slow');
  }
}

/**
 * opts: {
 *   environment: { id, name, values: [{ key, value, enabled, secret, discovered }], tunnelId },
 *   sources: discovery sources (lastSync.services[].instances with address, node, dc, zone, namespace),
 *   metrics: { [sourceId]: { rows } } (balancer.metrics),
 *   dns: { [host]: { addresses: [{ address }] } | { error } },
 *   local: [{ name, address, cidr, internal }] (this computer's interfaces),
 *   tunnel: { id, name } | null, bits4, bits6
 * }
 */
function build(opts) {
  const env = opts.environment || { values: [] };
  const sources = opts.sources || [];
  const metrics = opts.metrics || {};
  const dns = opts.dns || {};
  const bits = { bits4: opts.bits4 || 24, bits6: opts.bits6 || 64, own: opts.local || [] };
  const nodes = [];
  const edges = [];
  const groups = new Map();
  const add = (n) => { nodes.push({ flags: [], health: 'unknown', meta: {}, ...n }); return n.id; };
  const link = (from, to, requests = 0, errors = 0) => edges.push({ from, to, requests, errors });

  // Which network cluster an instance is in: its namespace, datacenter or zone, and segment.
  const groupFor = (inst, observedAddress, unknown = 'Address not known') => {
    const cluster = inst.namespace ? `namespace ${inst.namespace}` : inst.dc ? `datacenter ${inst.dc}` : inst.zone ? `zone ${inst.zone}` : '';
    const address = network.parse(inst.address || '') ? inst.address : network.parse(observedAddress || '') ? observedAddress : null;
    const d = address ? network.describe(address, bits) : null;
    const segment = d ? d.segment : '';
    const id = `g:${cluster}|${segment}`;
    if (!groups.has(id)) {
      const label = [cluster, segment].filter(Boolean).join(' · ') || unknown;
      groups.set(id, { id, label, cluster: cluster || null, segment: segment || null, kind: d ? d.kind : null, own: d && d.ownSegment ? d.ownSegment.adapter : null });
    }
    return id;
  };

  // This computer, and the tunnel the environment's requests go through.
  const own = (opts.local || []).filter((i) => !i.internal && (network.parse(i.address) || {}).family === 4);
  add({ id: 'client', kind: 'client', label: 'This computer', detail: own.length ? own.map((i) => `${i.name} ${i.cidr}`).slice(0, 2).join(', ') : '', health: 'ok', meta: { interfaces: own.map((i) => ({ name: i.name, address: i.address, cidr: i.cidr })) } });
  let entry = 'client';
  if (opts.tunnel) {
    add({ id: 'tunnel', kind: 'tunnel', label: opts.tunnel.name || 'Tunnel', detail: 'every request of this environment', health: 'ok', meta: { tunnelId: opts.tunnel.id } });
    link('client', 'tunnel');
    entry = 'tunnel';
  }

  const services = new Map(); // variable -> { src, svc }
  for (const src of sources) for (const svc of (src.lastSync && src.lastSync.services) || []) if (svc.variable) services.set(svc.variable, { src, svc });

  for (const row of env.values || []) {
    if (row.enabled === false || row.secret || !URL_VALUE.test(String(row.value || '').trim())) continue;
    const value = String(row.value).trim();
    const h = hostOf(value);
    if (!h) continue;
    const epId = `ep:${row.key}`;
    const found = services.get(row.key);
    // A pooled variable still holds the URL discovery gave it; one set by hand goes where it says.
    const pooled = !!(found && row.discovered === found.src.id && found.svc.url === value);
    add({
      id: epId, kind: 'endpoint', label: `{{${row.key}}}`, detail: h.display, health: 'ok',
      meta: { variable: row.key, url: value, source: found ? { id: found.src.id, name: found.src.name, provider: found.src.provider } : null, service: found ? found.svc.name : null, byHand: !!(found && !pooled) },
    });
    link(entry, epId);
    if (pooled) addService(epId, found.src, found.svc);
    else addAddresses(epId, h, value);
  }

  // A discovered service: its load balancer, if any, and its instances with their traffic.
  function addService(epId, src, svc) {
    const rows = (metrics[src.id] && metrics[src.id].rows || []).filter((r) => r.variable === svc.variable || r.service === svc.name);
    const instances = svc.instances || [];
    const k8s = svc.cluster && svc.cluster.kind === 'kubernetes' ? svc.cluster : null;
    const viaService = k8s && src.addressMode !== 'pods';
    const servedBy = [...new Set(rows.map((r) => r.servedBy).filter(Boolean))];
    let parent = epId;
    if (viaService) {
      parent = add({
        id: `lb:${epId}`, kind: 'balancer', label: `Service ${k8s.name}`, health: 'ok',
        detail: ['Kubernetes', k8s.type, k8s.clusterIp, k8s.external].filter(Boolean).join(' · '),
        meta: { spreads: 'Kubernetes spreads requests over the pods behind the Service', namespace: k8s.namespace, type: k8s.type, clusterIp: k8s.clusterIp, external: k8s.external, sourceId: src.id },
      });
      link(epId, parent);
    } else if (instances.length > 1) {
      const how = BALANCE_LABEL[src.balance] || BALANCE_LABEL.first;
      parent = add({ id: `lb:${epId}`, kind: 'balancer', label: 'HttpDash', detail: `${BALANCE_SHORT[src.balance] || BALANCE_SHORT.first} over ${instances.length} instances`, health: 'ok', meta: { spreads: `HttpDash sends each request to ${how}`, strategy: src.balance || 'first', sourceId: src.id } });
      link(epId, parent);
    }

    // Behind a load balancer that names who answered (the instance header), the backends are
    // what the traffic says; the registry only knows the balancer's address.
    if (servedBy.length && src.instanceHeader) {
      const lbHost = hostOf(instances[0] ? instances[0].url : svc.url);
      const lb = viaService ? parent : add({ id: `lbh:${epId}`, kind: 'balancer', label: 'Load balancer', detail: `${lbHost ? lbHost.display : ''} · names the backend in ${src.instanceHeader}`, health: 'ok', meta: { header: src.instanceHeader } });
      if (lb !== parent) link(parent, lb);
      const backends = servedBy.map((name) => {
        const mine = rows.filter((r) => r.servedBy === name);
        const t = totals(mine);
        const address = (mine.find((r) => r.address) || {}).address;
        return add({
          id: `in:${epId}:sb:${name}`, kind: 'instance', label: name, detail: 'named in the response', group: groupFor({ namespace: k8s && k8s.namespace }, address, 'Behind the load balancer'),
          health: 'ok', stats: t, meta: { servedBy: name, header: src.instanceHeader, service: svc.name, connectedTo: address, sourceId: src.id },
        });
      });
      const ins = backends.map((id) => nodes.find((n) => n.id === id));
      flagTraffic(ins);
      for (const n of ins) link(lb, n.id, n.stats ? n.stats.requests : 0, n.stats ? n.stats.errors : 0);
      return;
    }

    const made = [];
    for (const inst of instances) {
      const mine = rows.filter((r) => (inst.id && r.instanceId === inst.id) || r.instance === inst.url);
      const observed = (mine.find((r) => r.address) || {}).address;
      const h = hostOf(inst.url);
      const n = {
        id: `in:${epId}:${inst.id || inst.url}`, kind: 'instance',
        label: viaService ? (k8s.headless ? 'pods' : `pods behind ${k8s.name}`) : inst.id || (h ? h.display : inst.url),
        detail: viaService ? 'not listed: use the Pods address mode to see each one' : h ? h.display : inst.url,
        group: groupFor(inst, observed), health: viaService ? 'unknown' : inst.healthy === false ? 'down' : 'ok',
        stats: totals(mine), flags: viaService ? ['hidden'] : inst.healthy === false ? ['unhealthy'] : [],
        meta: { url: inst.url, address: inst.address || observed || null, node: inst.node || null, namespace: inst.namespace || null, dc: inst.dc || null, zone: inst.zone || null, service: svc.name, source: src.name, sourceId: src.id },
      };
      made.push(n);
    }
    // Instances that answered but are no longer in the registry.
    const known = new Set(instances.flatMap((i) => [i.id, i.url].filter(Boolean)));
    const left = new Map();
    for (const r of rows) {
      if (known.has(r.instanceId) || known.has(r.instance) || r.servedBy) continue;
      const key = r.instanceId || r.instance;
      if (!left.has(key)) left.set(key, []);
      left.get(key).push(r);
    }
    for (const [key, mine] of left) {
      const h = hostOf(mine[0].instance);
      made.push({
        id: `in:${epId}:left:${key}`, kind: 'instance', label: mine[0].instanceId || (h ? h.display : key), detail: 'left the pool',
        group: groupFor({}, mine[0].address), health: 'unknown', stats: totals(mine), flags: ['left'],
        meta: { url: mine[0].instance, address: mine[0].address || null, service: svc.name, source: src.name, sourceId: src.id },
      });
    }
    flagTraffic(made);
    for (const n of made) { add(n); link(parent, n.id, n.stats ? n.stats.requests : 0, n.stats ? n.stats.errors : 0); }
  }

  // A URL set by hand: the addresses its host resolves to are its instances.
  function addAddresses(epId, h, value) {
    const ip = network.parse(h.host);
    const k8sNs = /^[^.]+\.([^.]+)\.svc(\.cluster\.local)?$/i.exec(h.host);
    const resolved = ip ? { addresses: [{ address: h.host }] } : dns[h.host] || null;
    const addresses = resolved && resolved.addresses ? resolved.addresses : [];
    if (!addresses.length) {
      add({
        id: `in:${epId}:${h.host}`, kind: 'instance', label: h.display, detail: resolved && resolved.error ? 'not resolved from this computer' : 'address not known yet',
        group: groupFor({ namespace: k8sNs ? k8sNs[1] : null }, null), health: 'unknown', meta: { url: value, host: h.host, error: resolved ? resolved.error || null : null },
      });
      link(epId, `in:${epId}:${h.host}`);
      return;
    }
    let parent = epId;
    if (addresses.length > 1) {
      parent = add({ id: `lb:${epId}`, kind: 'balancer', label: 'DNS', detail: `${h.host} has ${addresses.length} addresses`, health: 'ok', meta: { spreads: 'Each connection goes to one of the addresses the name resolves to' } });
      link(epId, parent);
    }
    for (const a of addresses) {
      const id = add({
        id: `in:${epId}:${a.address}`, kind: 'instance', label: a.address, detail: ip ? 'address in the URL' : `${h.host}${a.ttl != null ? ` · TTL ${a.ttl} s` : ''}`,
        group: groupFor({ namespace: k8sNs ? k8sNs[1] : null, address: a.address }, null), health: 'ok', meta: { url: value, host: h.host, address: a.address },
      });
      link(parent, id);
    }
  }

  // An endpoint, balancer or tunnel carries the traffic of everything behind it.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const carried = (id) => edges.filter((e) => e.from === id).reduce((t, e) => {
    const into = byId.get(e.to).kind === 'instance' ? { requests: e.requests, errors: e.errors } : carried(e.to);
    return { requests: t.requests + into.requests, errors: t.errors + into.errors };
  }, { requests: 0, errors: 0 });
  for (const e of edges) {
    if (byId.get(e.to).kind === 'instance') continue;
    Object.assign(e, carried(e.to));
    if (e.requests) byId.get(e.to).requests = e.requests;
  }
  // Each edge's share of what its node sent on, and its state.
  const out = new Map();
  for (const e of edges) out.set(e.from, (out.get(e.from) || 0) + e.requests);
  for (const e of edges) {
    const total = out.get(e.from) || 0;
    e.share = total ? e.requests / total : null;
    e.state = !e.requests ? 'idle' : e.errors / e.requests >= 0.2 ? 'errors' : 'ok';
  }
  for (const n of nodes) if (n.stats) {
    const into = edges.find((e) => e.to === n.id);
    n.stats.share = into ? into.share : null;
  }

  return { nodes, edges, groups: [...groups.values()] };
}

/** The hosts of an environment's URL variables that DNS should be asked about (not IPs, not discovered). */
function hostsToResolve(environment, sources) {
  const discovered = new Set();
  for (const src of sources || []) for (const svc of (src.lastSync && src.lastSync.services) || []) if (svc.variable) discovered.add(svc.variable);
  const hosts = new Set();
  for (const row of (environment && environment.values) || []) {
    if (row.enabled === false || row.secret || !URL_VALUE.test(String(row.value || '').trim())) continue;
    if (discovered.has(row.key) && row.discovered) continue;
    const h = hostOf(String(row.value).trim());
    if (h && !network.parse(h.host)) hosts.add(h.host);
  }
  return [...hosts];
}

module.exports = { build, hostsToResolve };
