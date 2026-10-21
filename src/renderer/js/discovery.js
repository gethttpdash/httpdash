'use strict';

/* Service discovery: registry sources that create/refresh an environment with one variable per service.
   An OpenAPI document source also keeps a collection of its operations, reviewed version by version. */
(() => {
  const { h } = HD;
  const S = HD.S;

  const PROVIDERS = {
    consul: { label: 'Consul', short: 'Consul', url: 'http://consul.service.consul:8500', tokenLabel: 'ACL token (X-Consul-Token)', help: 'Reads /v1/catalog/services and each service\'s healthy instances.' },
    eureka: { label: 'Eureka (Spring Cloud)', short: 'Eureka', url: 'http://eureka:8761', tokenLabel: 'Authorization (optional, e.g. "Basic …")', help: 'Reads /eureka/apps and uses each app\'s home page URL or host:port.' },
    kubernetes: { label: 'Kubernetes', short: 'Kubernetes', url: 'https://kubernetes.example.com:6443', tokenLabel: 'Bearer token (service account)', help: 'Lists Services in a namespace through the API server.' },
    json: { label: 'Custom JSON endpoint', short: 'Custom JSON', url: 'https://registry.example.com/services', tokenLabel: 'Authorization (optional)', help: 'Any endpoint returning a list of services or a { name: url } map.' },
    openapi: { label: 'OpenAPI document', short: 'OpenAPI', url: 'https://api.example.com/openapi.json', tokenLabel: 'Authorization (optional, e.g. a bearer token)', help: 'Reads an OpenAPI (Swagger) document, JSON or YAML: its server becomes a base URL variable and every operation a request in a collection. Each new version of the document is compared with the last one, and you review what changed before it is applied.' },
  };
  HD.DISCOVERY_PROVIDERS = PROVIDERS;

  const sources = () => (S.ws.discoverySources = S.ws.discoverySources || []);
  HD.discoverySources = sources;

  // A source keeps its registry type's name until someone types their own, so the name follows the type: a source
  // made as Consul and switched to Custom JSON was left "Consul services", and so was the environment it created.
  const defaultName = (provider) => `${PROVIDERS[provider].short} services`;
  const isDefaultName = (name) => name === 'Custom services' || Object.keys(PROVIDERS).some((p) => name === defaultName(p));
  const followType = (src) => {
    const name = defaultName(src.provider);
    if (src.name === name || !isDefaultName(src.name)) return false;
    // Its environment too, while it still has the name the source gave it on its first sync.
    const env = S.ws.environments.find((e) => e.id === src.environmentId);
    if (env && env.name === src.name) env.name = name;
    src.name = name;
    return true;
  };
  // Sources saved before the name followed the type, put right when the workspace loads.
  HD.tidyDiscoveryNames = () => { if (sources().map(followType).some(Boolean)) HD.save(); };

  HD.newDiscoverySource = (provider = 'consul') => ({
    id: HD.uid(), name: defaultName(provider), provider, url: '', token: '', headers: [],
    variablePattern: '{name}_url', verifySSL: provider !== 'kubernetes', keepMissing: false, syncOnStartup: false, environmentId: null,
    datacenter: '', tag: '', scheme: 'http', onlyHealthy: true, onlyUp: true,
    namespace: 'default', addressMode: 'cluster-dns', labelSelector: '',
    listPath: '', nameField: 'name', urlField: 'url', lastSync: null,
    serviceName: '', baseUrl: '', syncRequests: true, collectionId: null, history: [],
    balance: 'first', instanceHeader: '',
  });

  /**
   * The instance pools for an environment's discovered variables, sent with each request's scopes
   * (see balancer.js). A variable whose value was changed by hand isn't pooled: the user's value wins.
   */
  HD.discoveryPools = (env) => {
    if (!env) return null;
    const pools = {};
    for (const src of sources()) {
      const ls = src.lastSync;
      if (src.environmentId !== env.id || !ls || !ls.services) continue;
      for (const svc of ls.services) {
        const row = env.values.find((v) => v.key === svc.variable && v.enabled !== false);
        if (!row || row.value !== svc.url) continue;
        pools[svc.variable] = {
          sourceId: src.id, service: svc.name, strategy: src.balance || 'first', header: src.instanceHeader || '', default: row.value,
          instances: (svc.instances || []).filter((i) => i.url),
        };
      }
    }
    return Object.keys(pools).length ? pools : null;
  };

  // 2026-10-21-0447, in local time, for file names.
  HD.localStamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
  /** How an instance is named in tables: its ID (pod, service instance) and address. */
  HD.instanceLabel = (r) => r.servedBy || r.instanceId || hostOf(r.instance);

  /**
   * Flags an instance that answers much slower than its siblings, or fails often: [{ kind, why }].
   * Times are compared with the median of the service's other instances, each with enough requests.
   * With `relative` (payloads), failing too means failing clearly more than the siblings: every
   * payload visits every instance, so a failing instance spreads its errors over all payloads, and
   * none of them should be blamed for it.
   */
  HD.trafficFlags = (r, siblings, { relative = false } = {}) => {
    const MIN = 5;
    const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
    const out = [];
    const bad = r.status['5xx'] + r.errors;
    const rate = r.requests ? bad / r.requests : 0;
    const others = siblings.filter((x) => x !== r && x.requests >= MIN && x.p50 != null);
    // Relative: the failure rate must be clearly above the siblings' together, not a few unlucky
    // requests (a two-proportion z-test; 3 of 8 against 2 of 16 is chance, 8 of 8 against 0 of 16 isn't).
    let clearlyWorse = !relative;
    let othersRate = null;
    if (relative) {
      const rest = siblings.filter((x) => x !== r);
      const n2 = rest.reduce((n, x) => n + x.requests, 0);
      const bad2 = rest.reduce((n, x) => n + x.status['5xx'] + x.errors, 0);
      if (n2 >= MIN && r.requests) {
        othersRate = bad2 / n2;
        const pooled = (bad + bad2) / (r.requests + n2);
        const se = Math.sqrt(pooled * (1 - pooled) * (1 / r.requests + 1 / n2));
        clearlyWorse = se > 0 && (rate - othersRate) / se >= 2.5;
      }
    }
    if (r.requests >= MIN && rate >= 0.2 && clearlyWorse) {
      out.push({ kind: 'failing', why: `${bad} of ${r.requests} requests ended in a 5xx or a connection error${othersRate != null ? `, against ${Math.round(othersRate * 100)}% for the other payloads` : ''}` });
    }
    if (r.requests >= MIN && r.p50 != null && others.length) {
      for (const p of ['p50', 'p95']) {
        const m = median(others.map((x) => x[p]));
        if (m != null && r[p] >= 2 * m && r[p] - m >= 50) {
          out.push({ kind: 'slow', why: `${p} ${HD.formatMs(r[p])} vs ${HD.formatMs(Math.round(m))} for the others` });
          break;
        }
      }
    }
    return out;
  };

  /**
   * Requests per instance: count, share of the service's requests, status classes, errors, p50/p95.
   * `known` ({ service: [{ id, url, healthy }] }) lists instances that had no traffic yet as well,
   * so an instance that never gets a request stands out.
   */
  /**
   * The rows of a traffic table, grouped by service, busiest first, each with its share of the
   * service's requests and its flags ([{ kind: 'slow' | 'failing' | 'left the pool', why }]).
   * `known` ({ service: [{ id, url, healthy }] }, the last sync's instances) adds instances that
   * had no traffic yet, so one that never gets a request stands out, and marks those that are no
   * longer in the pool. An instance counted by a load balancer's header isn't listed again empty.
   */
  HD.trafficRows = (rows, known = {}, { relative = false } = {}) => {
    const all = rows.map((r) => ({ ...r }));
    for (const [service, instances] of Object.entries(known)) {
      for (const i of instances) {
        if (all.some((r) => r.service === service && r.instance === i.url)) continue;
        all.push({ service, instance: i.url, instanceId: i.id || '', servedBy: '', requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, errors: 0, p50: null, p95: null, avg: null, healthy: i.healthy });
      }
    }
    const services = [...new Set(all.map((r) => r.service))].sort();
    return services.flatMap((service) => {
      const list = all.filter((r) => r.service === service).sort((a, b) => b.requests - a.requests || HD.instanceLabel(a).localeCompare(HD.instanceLabel(b)));
      const total = list.reduce((n, r) => n + r.requests, 0);
      const pool = known[service];
      return list.map((r) => {
        const flags = HD.trafficFlags(r, list, { relative });
        if (pool && !r.servedBy && !pool.some((i) => i.url === r.instance)) flags.push({ kind: 'left the pool', why: 'Not in the last sync: the registry no longer lists it (a failed health check, a scale-down or a redeploy)' });
        return { ...r, share: total ? r.requests / total : 0, serviceTotal: total, flags };
      });
    });
  };

  const FLAG_PILL = { slow: 'changed', failing: 'removed' };
  HD.trafficTable = (rows, known = {}, { label = 'Instance', relative = false } = {}) => {
    const list = HD.trafficRows(rows, known, { relative });
    const services = [...new Set(list.map((r) => r.service))];
    const ms = (v) => (v == null ? '—' : HD.formatMs(v));
    return h('div.table-wrap.no-pad', h('table.data-table.traffic-table',
      h('thead', h('tr', h('th', label), h('th.num', { title: 'Requests' }, 'Req.'), h('th', 'Share'), h('th.num', { title: 'Median response time' }, 'p50'), h('th.num', { title: '95th percentile: 1 in 20 requests is slower' }, 'p95'),
        h('th.num', { title: '2xx and 3xx responses' }, 'OK'), h('th.num', '4xx'), h('th.num', '5xx'), h('th.num', { title: 'Connection errors and timeouts' }, 'Err'))),
      h('tbody', services.flatMap((service) => {
        const group = list.filter((r) => r.service === service);
        const total = group[0].serviceTotal;
        return [
          services.length > 1 || group.length > 1 ? h('tr.traffic-service', h('td', { colspan: 9 }, h('strong', service), h('span.muted.small', ` · ${total} request${total === 1 ? '' : 's'}`))) : null,
          ...group.map((r) => h('tr', { class: r.healthy === false ? 'muted' : '' },
            h('td', h('div.traffic-name', HD.instanceLabel(r), r.healthy === false ? h('span.small.text-warn', 'not ready') : null,
              ...r.flags.map((f) => h(`span.pill.${FLAG_PILL[f.kind] || 'muted'}`, { title: f.why }, f.kind))),
              h('div.muted.small.mono', r.servedBy ? `answered via ${hostOf(r.instance)}` : r.instanceId ? hostOf(r.instance) : '')),
            h('td.num', String(r.requests)),
            h('td', h('div.share', h('div.share-bar', h('span', { style: `width:${Math.round(r.share * 100)}%` })), h('span.small.muted', `${Math.round(r.share * 100)}%`))),
            h('td.num', ms(r.p50)), h('td.num', ms(r.p95)),
            h('td.num', String(r.status['2xx'] + r.status['3xx'])),
            h('td.num', { class: r.status['4xx'] ? 'text-warn' : '' }, String(r.status['4xx'])),
            h('td.num', { class: r.status['5xx'] ? 'text-error' : '' }, String(r.status['5xx'])),
            h('td.num', { class: r.errors ? 'text-error' : '' }, String(r.errors)))),
        ];
      }))));
  };

  // `sub` picks the tab's page: 'config' (the default) or 'traffic'.
  HD.openDiscovery = (id, sub, opts = {}) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'discovery' && t.refId === id);
    if (existing) {
      if (sub) existing.ui = { ...(existing.ui || {}), sub };
      if (opts.pin) HD.pinTab(existing);
      return HD.activateTab(existing.id);
    }
    return HD.addTab({ id: HD.uid(), kind: 'discovery', refId: id, ...(sub ? { ui: { sub } } : {}) }, opts);
  };

  HD.addDiscoverySource = () => {
    const src = HD.newDiscoverySource('consul');
    sources().push(src);
    HD.save();
    HD.renderSidebar();
    HD.openDiscovery(src.id);
  };

  const varsForResolve = () => {
    const env = HD.activeEnvironment();
    return { ...HD.listToObject(S.ws.globals), ...(env ? HD.listToObject(env.values) : {}) };
  };

  const collectionOf = (src) => (src.collectionId && S.ws.collections.find((c) => c.id === src.collectionId)) || null;
  const isOpenApi = (src) => src.provider === 'openapi';

  // Calls the registry. With previewOnly, nothing is written: the result says what would change.
  const call = (src, previewOnly, expectHash = null) => {
    const env = S.ws.environments.find((e) => e.id === src.environmentId);
    const col = isOpenApi(src) ? collectionOf(src) : null;
    const { history, lastSync, available, ...config } = src;
    return window.api.syncDiscovery({
      config: HD.clone(config), values: env ? HD.clone(env.values) : [], collection: col ? HD.clone(col) : null, sourceId: src.id,
      settings: S.ws.settings, vars: varsForResolve(), previewOnly, expectHash,
    });
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const versionLabel = (spec) => (spec && spec.version ? `version ${spec.version}` : 'a version without a number');
  // How many things a sync would change: variables, requests and the collection itself.
  const changeCount = (res) => {
    const d = res.diff || { added: [], updated: [], removed: [] };
    const rq = res.requests;
    return d.added.length + d.updated.length + d.removed.length + (rq ? rq.changes.length + rq.collection.length : 0);
  };
  const requestSummary = (rq) => [
    rq.added.length && `${rq.added.length} added`, rq.updated.length && `${rq.updated.length} changed`,
    rq.removed.length && `${rq.removed.length} removed`, rq.kept.length && `${rq.kept.length} kept`,
  ].filter(Boolean).join(', ') || 'no request changes';
  // What lastSync and the history keep of a sync's report (a long first sync is cut short).
  const trimReport = (rq) => rq && ({ ...rq, changes: rq.changes.slice(0, 500) });

  /** Syncs a source into its environment, creating the environment the first time. */
  HD.syncDiscovery = async (src, { silent = false, expectHash = null } = {}) => {
    try {
      const res = await call(src, false, expectHash);
      let env = S.ws.environments.find((e) => e.id === src.environmentId);
      if (!env) {
        env = HD.newEnvironment(src.name);
        S.ws.environments.push(env);
        src.environmentId = env.id;
        if (!S.ws.activeEnvironmentId) S.ws.activeEnvironmentId = env.id;
      }
      env.values = res.values;
      env.discoverySourceId = src.id;
      if (res.collection) {
        const i = S.ws.collections.findIndex((c) => c.id === res.collection.id);
        if (i === -1) S.ws.collections.push(res.collection);
        else S.ws.collections[i] = res.collection;
        src.collectionId = res.collection.id;
      }
      const rq = res.requests || null;
      src.lastSync = {
        time: Date.now(), count: res.operations ? res.operations.length : res.services.length, diff: res.diff, warnings: res.warnings, error: null,
        services: res.services.map((s) => ({ name: s.name, variable: s.variable, url: s.url, instances: (s.instances || []).map((i) => ({ id: i.id || '', url: i.url, healthy: i.healthy })) })),
        spec: res.spec || null, requests: trimReport(rq),
        ...(res.shapes ? { shapes: res.shapes } : {}),
      };
      // Every version that changed something is kept in the source's history.
      if (res.spec && changeCount(res)) {
        const d = res.diff;
        src.history = [{
          time: Date.now(), spec: res.spec, previous: rq && rq.spec.previous, sameVersion: !!(rq && rq.spec.sameVersion),
          variables: [...d.added, ...d.updated, ...d.removed], requests: trimReport(rq),
        }, ...(src.history || [])].slice(0, 20);
      }
      delete src.available;
      HD.save();
      HD.renderSidebar();
      HD.renderEnvSelect();
      HD.emit('variables');
      const d = res.diff;
      const summary = res.spec
        ? `${versionLabel(res.spec)}: ${rq ? requestSummary(rq) : plural(d.added.length + d.updated.length, 'variable') + ' changed'}`
        : `${plural(res.services.length, 'service')}: ${d.added.length} added, ${d.updated.length} updated, ${d.removed.length} removed`;
      HD.log('info', `Service discovery "${src.name}" → environment "${env.name}": ${summary}`);
      if (!silent || changeCount(res)) HD.toast(`${res.spec ? src.name : env.name}: ${summary}`, 'success');
      return res;
    } catch (e) {
      const msg = HD.cleanErr(e);
      src.lastSync = { ...(src.lastSync || {}), time: Date.now(), error: msg };
      HD.save();
      HD.log('error', `Service discovery "${src.name}" failed: ${msg}`);
      HD.toast(`Discovery "${src.name}" failed: ${msg}`, 'error', 6000);
      return null;
    }
  };

  /** Asks an OpenAPI source's document what changed, without writing; marks the source when there's something to review. */
  HD.checkDiscovery = async (src) => {
    const res = await call(src, true);
    const n = changeCount(res);
    if (n) src.available = { time: Date.now(), spec: res.spec, count: n };
    else delete src.available;
    HD.save();
    HD.renderSidebar();
    return res;
  };

  // A registry source syncs; an OpenAPI source that already has its collection only checks, and
  // says when a new version is waiting for review, so nothing changes under the user unseen.
  HD.syncDiscoveryOnStartup = async () => {
    for (const src of sources().filter((s) => s.syncOnStartup && s.url)) {
      if (!isOpenApi(src) || !collectionOf(src)) { await HD.syncDiscovery(src, { silent: true }); continue; }
      try {
        const res = await HD.checkDiscovery(src);
        if (src.available) HD.toast(`${src.name}: ${versionLabel(res.spec)} has ${plural(src.available.count, 'change')}. Open the source to review them.`, 'info', 8000);
      } catch (e) {
        HD.log('error', `Service discovery "${src.name}" check failed: ${HD.cleanErr(e)}`);
      }
    }
  };

  // ---- Sidebar section (inside the Environments panel) -----------------------------------------

  HD.renderDiscoverySidebar = (list) => {
    list.appendChild(h('div.history-day.side-section', h('span', 'Service discovery'), h('span.spacer'),
      h('button.tree-more.visible', { type: 'button', title: 'Add a discovery source', onclick: () => HD.addDiscoverySource() }, HD.icon('plus'))));
    if (!sources().length) {
      list.appendChild(h('div.tree-empty.discovery-empty', 'Create environments from Consul, Eureka, Kubernetes or a JSON registry. ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); HD.addDiscoverySource(); } }, 'Add a source')));
      return;
    }
    const active = HD.currentTab();
    for (const src of sources()) {
      const ls = src.lastSync;
      list.appendChild(h('div.tree-row.env-row', {
        class: active && active.kind === 'discovery' && active.refId === src.id ? 'active' : '',
        onclick: () => HD.openDiscovery(src.id, undefined, { preview: true }),
        ondblclick: () => HD.openDiscovery(src.id, undefined, { pin: true }),
        oncontextmenu: (e) => HD.menu(e, sourceMenu(src)),
      },
      HD.icon('search'),
      h('span.tree-name', src.name),
      src.available ? h('span.pill.updated', { title: `${plural(src.available.count, 'change')} to review` }, 'new') : null,
      ls && ls.error ? h('span.small.text-error', 'error') : ls ? h('span.muted.small', String(ls.count)) : null,
      h('button.tree-more', { type: 'button', title: 'Sync now', onclick: (e) => { e.stopPropagation(); HD.syncDiscovery(src); } }, HD.icon('history'))));
    }
  };

  const sourceMenu = (src) => [
    { label: 'Sync now', onClick: () => HD.syncDiscovery(src) },
    { label: 'Edit', onClick: () => HD.openDiscovery(src.id, 'config') },
    { label: 'Traffic by instance', onClick: () => HD.openDiscovery(src.id, 'traffic') },
    { label: 'Duplicate', onClick: () => { const c = { ...HD.clone(src), id: HD.uid(), name: `${src.name} Copy`, environmentId: null, collectionId: null, lastSync: null, history: [], available: undefined }; sources().push(c); HD.save(); HD.renderSidebar(); } },
    { separator: true },
    { label: 'Delete source', danger: true, onClick: async () => {
      if (!(await HD.confirm('Delete discovery source', `Delete "${src.name}"? Its environment is kept.`, { danger: true, okLabel: 'Delete' }))) return;
      sources().splice(sources().indexOf(src), 1);
      const col = collectionOf(src);
      if (col && col.openapi) delete col.openapi.sourceId; // the collection stays, as an ordinary one
      S.ws.tabs.filter((t) => t.kind === 'discovery' && t.refId === src.id).forEach((t) => HD.closeTab(t.id, true));
      HD.save();
      HD.renderSidebar();
    } },
  ];

  // Banner for an environment that is filled by discovery.
  HD.discoveryBannerFor = (env) => {
    const src = sources().find((s) => s.environmentId === env.id);
    if (!src) return null;
    const ls = src.lastSync;
    return h('div.discovery-banner',
      HD.icon('search'),
      h('span', 'Service URLs in this environment come from ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); HD.openDiscovery(src.id); } }, src.name),
        ls ? ` · last synced ${new Date(ls.time).toLocaleString()}` : '', '. Other variables you add here are kept on re-sync.'),
      h('span.spacer'),
      HD.button('Re-sync', () => HD.syncDiscovery(src).then(() => HD.renderActiveTab()), { small: true }));
  };

  // ---- Source editor tab ------------------------------------------------------------------

  HD.views = HD.views || {};
  HD.views.discovery = (tab, root) => {
    const src = sources().find((s) => s.id === tab.refId);
    if (!src) {
      root.appendChild(h('div.empty-state', 'This discovery source no longer exists.'));
      return;
    }
    HD.variableInfo = () => HD.variableInfoFor(null);
    tab.ui = tab.ui || {};
    const sub = tab.ui.sub === 'traffic' ? 'traffic' : 'config';
    const touch = () => { HD.pinTab(tab); HD.save(); };
    const rerender = () => { HD.clear(root); HD.views.discovery(tab, root); };
    const p = PROVIDERS[src.provider];

    const text = (key, label, placeholder, help, type = 'text') => h('label.field', h('span', label),
      (type === 'password' ? HD.revealable : (x) => x)(h('input.input', { type, value: src[key] == null ? '' : src[key], placeholder, spellcheck: 'false', autocomplete: type === 'password' ? 'off' : undefined, oninput: (e) => { src[key] = e.target.value; touch(); } })),
      help ? h('span.field-help', help) : null);
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: src[key] !== false && !!src[key], onchange: (e) => { src[key] = e.target.checked; touch(); } }), label);
    const select = (key, label, options, help) => h('label.field', h('span', label), HD.select(options, src[key], (v) => { src[key] = v; touch(); }), help ? h('span.field-help', help) : null);

    let providerFields;
    if (src.provider === 'consul') {
      providerFields = [text('datacenter', 'Datacenter', 'dc1 (default: the agent\'s)'), text('tag', 'Only services with tag', 'e.g. http'),
        select('scheme', 'URL scheme', [['http', 'http'], ['https', 'https']]), check('onlyHealthy', 'Only instances passing health checks')];
    } else if (src.provider === 'eureka') {
      providerFields = [check('onlyUp', 'Only instances with status UP')];
    } else if (src.provider === 'kubernetes') {
      providerFields = [text('namespace', 'Namespace', 'default', 'Use * for all namespaces (variables become namespace_service_url).'),
        select('addressMode', 'Address to use', [['cluster-dns', 'Cluster DNS (name.namespace.svc.cluster.local)'], ['cluster-ip', 'Cluster IP'], ['pods', 'Pods (each ready pod, from the endpoints)'], ['external', 'External (LoadBalancer / external IP)']],
          'Pods lists every pod behind a Service, so requests can be spread over them and counted per pod. Cluster DNS, Cluster IP and Pods only work from inside the cluster or over a VPN.'),
        text('labelSelector', 'Label selector', 'e.g. app.kubernetes.io/part-of=shop')];
    } else if (src.provider === 'openapi') {
      providerFields = [text('serviceName', 'Service name', 'default: the document\'s title', 'Names the base URL variable, e.g. "lots" gives {{lots_url}}.'),
        text('baseUrl', 'Base URL', 'default: the document\'s server', 'Set this when the API runs somewhere other than the server the document lists. Variables are allowed.'),
        check('syncRequests', 'Keep a collection with a request for every operation')];
    } else {
      providerFields = [text('listPath', 'List path', 'e.g. data.services (empty: the whole response)', 'Where the list (or name → URL map) sits in the response.'),
        text('nameField', 'Name field', 'name'), text('urlField', 'URL field or template', 'url', 'A field (e.g. url, endpoints[0].href) or a template such as http://{host}:{port}.')];
    }

    const envOptions = [['', 'Create a new environment'], ...S.ws.environments.map((e) => [e.id, e.name])];
    const results = h('div.discovery-results');
    const config = h('div.discovery-config',
      h('div.dep-grid',
        h('label.field', h('span', 'Registry type'), HD.select(Object.entries(PROVIDERS).map(([id, x]) => [id, x.label]), src.provider, (v) => {
          src.provider = v;
          if (v === 'kubernetes') src.verifySSL = false;
          if (v === 'openapi' && src.syncRequests === undefined) src.syncRequests = true;
          if (followType(src)) { HD.renderSidebar(); HD.renderTabBar(); HD.renderEnvSelect(); }
          touch();
          rerender();
        })),
        text('url', isOpenApi(src) ? 'Document URL' : 'Registry URL', p.url, 'Variables like {{consulUrl}} are allowed.'),
        text('token', p.tokenLabel, '', null, 'password'),
        ...providerFields),
      h('div.section-title', 'Environment'),
      h('div.dep-grid',
        h('label.field', h('span', 'Sync into'), HD.select(envOptions, src.environmentId || '', (v) => { src.environmentId = v || null; touch(); }),
          h('span.field-help.env-target-help', src.environmentId ? 'Discovered variables in this environment are updated in place.' : `A new environment named "${src.name}" is created on the first sync.`)),
        text('variablePattern', 'Variable name pattern', '{name}_url', '{name} is the service name in lower_snake_case; {NAME} in UPPER_CASE.')),
      check('keepMissing', 'Keep variables for services that disappear from the registry'),
      check('verifySSL', 'Verify the registry\'s SSL certificate'),
      check('syncOnStartup', 'Sync automatically when HttpDash starts'),
      h('div.section-title', 'Load balancing'),
      h('div.dep-grid',
        !isOpenApi(src) ? select('balance', 'Send requests to', [['first', 'The first instance (always the same)'], ['round-robin', 'Each instance in turn (round robin)'], ['random', 'A random instance']],
          'For requests that use this source\'s variables, in Send, the Runner and Monitors. Instances that aren\'t healthy are skipped.') : null,
        text('instanceHeader', 'Instance header', 'e.g. X-Served-By', 'When a load balancer sits in front, the response header that names the instance that answered. Requests are counted by its value too.')),
      h('details.discovery-headers', h('summary', `Extra request headers${(src.headers || []).filter((x) => x.key).length ? ` (${src.headers.filter((x) => x.key).length})` : ''}`),
        HD.kvTable({ rows: (src.headers = src.headers || []), onChange: touch, bulk: false })),
      isOpenApi(src) ? h('div.button-row.discovery-actions',
        HD.button('Check for changes', async () => {
          HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Reading the document…'));
          try {
            renderReport(await HD.checkDiscovery(src), false);
          } catch (e) {
            HD.clear(results).appendChild(h('div.test-script-error', HD.cleanErr(e)));
          }
        }, { icon: 'search', primary: !!src.lastSync }),
        // The first sync has nothing to compare with, so it can create straight away.
        !src.lastSync ? HD.button(`Create ${src.syncRequests !== false ? 'collection and ' : ''}environment`, () => apply(null), { primary: true, icon: 'download' }) : null,
        collectionOf(src) ? HD.button('Open collection', () => HD.openContainer(src.collectionId), { ghost: true }) : null,
        src.environmentId ? HD.button('Open environment', () => HD.openEnvironment(src.environmentId), { ghost: true }) : null)
      : h('div.button-row.discovery-actions',
        HD.button('Preview services', async () => {
          HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Querying registry…'));
          try {
            const res = await call(src, true);
            renderResults(res, null);
          } catch (e) {
            HD.clear(results).appendChild(h('div.test-script-error', HD.cleanErr(e)));
          }
        }, { icon: 'search' }),
        HD.button(src.environmentId ? 'Sync to environment' : 'Create environment', async () => {
          HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Syncing…'));
          const res = await HD.syncDiscovery(src);
          if (res) rerender(); else HD.clear(results).appendChild(h('div.test-script-error', src.lastSync.error));
        }, { primary: true, icon: 'download' }),
        src.environmentId ? HD.button('Open environment', () => HD.openEnvironment(src.environmentId), { ghost: true }) : null));

    const renderResults = (res, diff) => {
      HD.clear(results);
      const changed = diff ? new Map([...diff.added.map((k) => [k, 'added']), ...diff.updated.map((k) => [k, 'updated'])]) : new Map();
      results.appendChild(h('div.section-title', `${res.services.length} services found`));
      for (const w of res.warnings || []) results.appendChild(h('div.discovery-warning', w));
      if (diff && diff.removed.length) results.appendChild(h('div.discovery-warning', `Removed: ${diff.removed.join(', ')}`));
      if (!res.services.length) return;
      results.appendChild(h('div.table-wrap.no-pad', h('table.data-table',
        h('thead', h('tr', h('th', 'Service'), h('th', 'Variable'), h('th', 'URL'), h('th', 'Instances'), diff ? h('th', '') : null)),
        h('tbody', res.services.map((s) => h('tr',
          h('td', s.name),
          h('td.mono', `{{${s.variable}}}`),
          h('td.mono.break', s.url),
          h('td.muted', s.instances && s.instances.length ? `${s.instances.filter((i) => i.healthy).length}/${s.instances.length} healthy` : '—'),
          diff ? h('td', changed.get(s.variable) ? h(`span.pill.${changed.get(s.variable)}`, changed.get(s.variable)) : null) : null))))));
    };

    // The latest requests, newest first: when each was sent, the gap since the one before, and who answered.
    const recentList = (recent) => {
      const clock = (t) => { const d = new Date(t); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
      const withPayload = recent.some((r) => r.payload);
      return h('div.traffic-recent',
        h('div.section-title', `Recent requests`, h('span.muted.small', ` · last ${recent.length}`)),
        h('div.table-wrap.no-pad', h('table.data-table.traffic-table',
          h('thead', h('tr', h('th', 'Sent'), h('th.num', { title: 'Milliseconds between the previous response and this request' }, 'Gap'), h('th', 'Instance'), withPayload ? h('th', 'Payload') : null, h('th', 'Status'), h('th.num', 'Time'))),
          h('tbody', recent.slice(0, 50).map((r) => h('tr',
            h('td.mono.small', clock(r.sentAt)),
            h('td.num.muted', r.gap == null ? '—' : `+${HD.formatMs(Math.max(0, Math.round(r.gap)))}`),
            h('td', h('span', HD.instanceLabel(r)), h('span.muted.small', ` {{${r.variable}}}`)),
            withPayload ? h('td', r.payload || h('span.muted', '—')) : null,
            h('td', r.error ? h('span.text-error.small', r.error) : h(`span.${HD.statusClass(r.status)}`, String(r.status))),
            h('td.num', r.time == null ? '—' : HD.formatMs(r.time))))))));
    };

    // The Traffic page: what this source's instances have answered, refreshed every second while shown.
    const traffic = h('div.panel-pad.discovery-traffic');
    const renderTraffic = async () => {
      if (!traffic.isConnected && traffic.dataset.drawn) return; // the tab was closed, switched or drawn anew
      let m;
      try { m = await window.api.discoveryMetrics(src.id); } catch { return; }
      const services = (src.lastSync && src.lastSync.services) || [];
      const known = {};
      if (!isOpenApi(src)) for (const svc of services) if (svc.instances && svc.instances.some((i) => i.url)) known[svc.name] = svc.instances.filter((i) => i.url);
      const strategy = isOpenApi(src) ? null : { 'round-robin': 'each instance in turn (round robin)', random: 'a random instance' }[src.balance] || 'the first instance';
      const total = m.rows.reduce((n, r) => n + r.requests, 0);
      const rows = HD.trafficRows(m.rows, known);
      const flagged = rows.flatMap((r) => r.flags); // instances only: a payload's flags have their own table
      const answering = new Set(m.rows.map((r) => `${r.service}|${r.instance}|${r.servedBy}`)).size;
      // Payload rows look like instance rows to the table: the payload's name is the "instance".
      const payloadRows = (m.byPayload || []).map((r) => ({ ...r, instance: '', instanceId: r.payload, servedBy: '' }));
      // The same for network segments: the segment is the "instance".
      const segmentRows = (m.bySegment || []).map((r) => ({ ...r, instance: '', instanceId: r.segment, servedBy: '' }));
      // The report every export format is made from: what this page shows.
      const report = () => ({
        source: src.name, registry: PROVIDERS[src.provider].label, strategy, header: src.instanceHeader || '', since: m.since, generatedAt: Date.now(),
        totals: { requests: total, instances: answering, slow: flagged.filter((f) => f.kind === 'slow').length, failing: flagged.filter((f) => f.kind === 'failing').length },
        rows: rows.map((r) => ({
          service: r.service, instanceId: r.instanceId, instance: r.instance, servedBy: r.servedBy, requests: r.requests, share: r.share,
          p50: r.p50, p95: r.p95, avg: r.avg, ok: r.status['2xx'] + r.status['3xx'], s4xx: r.status['4xx'], s5xx: r.status['5xx'], errors: r.errors, flags: r.flags.map((f) => f.kind),
        })),
        byPayload: HD.trafficRows(payloadRows, {}, { relative: true }).map((r) => ({
          service: r.service, payload: r.instanceId, requests: r.requests, share: r.share, p50: r.p50, p95: r.p95, avg: r.avg,
          ok: r.status['2xx'] + r.status['3xx'], s4xx: r.status['4xx'], s5xx: r.status['5xx'], errors: r.errors, flags: r.flags.map((f) => f.kind),
        })),
        bySegment: HD.trafficRows(segmentRows, {}, { relative: true }).map((r) => ({
          service: r.service, segment: r.instanceId, requests: r.requests, share: r.share, p50: r.p50, p95: r.p95, avg: r.avg,
          ok: r.status['2xx'] + r.status['3xx'], s4xx: r.status['4xx'], s5xx: r.status['5xx'], errors: r.errors, flags: r.flags.map((f) => f.kind),
        })),
        recent: m.recent || [],
      });
      const exportAs = async (format) => {
        try {
          const file = await window.api.exportReport({ format, name: `${src.name} traffic ${HD.localStamp()}`, report: report() });
          if (file) HD.toast(`Saved ${file.split(/[\\/]/).pop()}`, 'success');
        } catch (e) { HD.toast(HD.cleanErr(e), 'error', 6000); }
      };
      HD.clear(traffic);
      traffic.dataset.drawn = '1';
      traffic.appendChild(h('div.traffic-bar',
        h('span.live-dot', { title: 'Updates every second' }), h('span.small', 'Live'),
        h('span.muted.small', [
          strategy ? `Sending to ${strategy}` : null,
          src.instanceHeader ? `counting by the ${src.instanceHeader} header` : null,
          `since ${new Date(m.since).toLocaleTimeString()}`,
        ].filter(Boolean).join(' · ')),
        h('span.spacer'),
        HD.button('Change', () => { tab.ui.sub = 'config'; HD.save(); rerender(); }, { small: true, ghost: true }),
        HD.button('Export', (e) => HD.menu(e, [
          { label: 'Excel (.xlsx)', hint: 'by instance + recent', onClick: () => exportAs('xlsx') },
          { label: 'CSV', hint: 'by instance', onClick: () => exportAs('csv') },
          { label: 'PDF', onClick: () => exportAs('pdf') },
          { label: 'Image (.png)', onClick: () => exportAs('png') },
          { label: 'HTML page', onClick: () => exportAs('html') },
          { label: 'Markdown', hint: 'for a ticket or chat', onClick: () => exportAs('md') },
          { label: 'JSON', onClick: () => exportAs('json') },
        ]), { small: true, icon: 'upload', disabled: !m.rows.length, title: 'Export this report' }),
        HD.button('Reset', async () => { await window.api.resetDiscoveryMetrics(src.id); renderTraffic(); }, { small: true, disabled: !m.rows.length })));
      if (!services.length && !m.rows.length) {
        traffic.appendChild(h('div.empty-state.small', h('div', 'Nothing to show yet: sync this source first.'),
          h('div.muted', 'Then every request that uses its variables, in Send, the Runner or Monitors, is counted here per instance.')));
      } else {
        traffic.appendChild(h('div.runner-summary.traffic-summary',
          h('div.stat', h('div.stat-value', String(total)), h('div.stat-label', 'Requests')),
          h('div.stat', h('div.stat-value', String(answering)), h('div.stat-label', 'Instances answering')),
          h('div.stat', { class: flagged.some((f) => f.kind === 'slow') ? 'warn' : '' }, h('div.stat-value', String(flagged.filter((f) => f.kind === 'slow').length)), h('div.stat-label', 'Slow')),
          h('div.stat', { class: flagged.some((f) => f.kind === 'failing') ? 'fail' : '' }, h('div.stat-value', String(flagged.filter((f) => f.kind === 'failing').length)), h('div.stat-label', 'Failing'))));
        traffic.appendChild(HD.trafficTable(m.rows, known));
        if (payloadRows.length) {
          traffic.appendChild(h('div.section-title.traffic-sub', 'By payload', h('span.muted.small', ' · flags compare each payload with the endpoint\'s other payloads')));
          traffic.appendChild(HD.trafficTable(payloadRows, {}, { label: 'Payload', relative: true }));
        }
        // Only worth a table when the instances sit on more than one segment.
        if (new Set(segmentRows.map((r) => `${r.service}|${r.instanceId}`)).size > new Set(segmentRows.map((r) => r.service)).size) {
          traffic.appendChild(h('div.section-title.traffic-sub', 'By network segment', h('span.muted.small', ' · the address that answered, by segment; flags compare each segment with the service\'s others')));
          traffic.appendChild(HD.trafficTable(segmentRows, {}, { label: 'Segment', relative: true }));
        }
        if (m.recent && m.recent.length) traffic.appendChild(recentList(m.recent));
        if (!m.rows.length) traffic.appendChild(h('div.muted.small.traffic-hint', `No requests yet. Send or run requests that use ${services.slice(0, 2).map((x) => `{{${x.variable}}}`).join(' or ')}.`));
        else if (!isOpenApi(src) && src.balance !== 'round-robin' && src.balance !== 'random' && !src.instanceHeader) {
          traffic.appendChild(h('div.muted.small.traffic-hint', 'Every request goes to the first instance. To compare instances, send to each in turn (round robin) under Configuration → Load balancing.'));
        }
      }
      setTimeout(() => { if (traffic.isConnected) renderTraffic(); }, document.hidden ? 5000 : 1000);
    };

    // Applies a reviewed version; expectHash refuses a document that changed again since the review.
    const apply = async (expectHash) => {
      HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Syncing…'));
      const res = await HD.syncDiscovery(src, { expectHash });
      if (res) rerender(); else HD.clear(results).appendChild(h('div.test-script-error', src.lastSync.error));
    };

    const KINDS = [
      ['added', 'Added', 'New operations, created as requests.'],
      ['changed', 'Changed', 'Operations the document changed. Your own edits are kept.'],
      ['removed', 'Removed', 'Operations no longer in the document; their requests are deleted.'],
      ['kept', 'Kept', 'Operations no longer in the document, whose requests you changed; they stay as your own requests.'],
    ];
    const changeList = (rq, applied) => {
      const out = [];
      for (const [kind, label, help] of KINDS) {
        const list = rq.changes.filter((c) => c.kind === kind);
        if (!list.length) continue;
        out.push(h('details.oas-group', { open: list.length <= 25 },
          h('summary', h(`span.pill.${kind}`, `${label} ${list.length}`), h('span.muted.small', applied ? '' : help)),
          list.map((c) => {
            const [method, path] = [c.op.slice(0, c.op.indexOf(' ')), c.op.slice(c.op.indexOf(' ') + 1)];
            return h('div.oas-change',
              h('div.oas-op', h(`span.method-tag.${HD.methodClass(method)}`, method.slice(0, 6)), h('span.mono.break', path), h('span.muted.oas-name', c.name)),
              c.details && c.details.length && kind !== 'kept' ? h('ul.oas-details', c.details.map((d) => h('li', d))) : null,
              c.kept && c.kept.length ? h('div.oas-yours', `Kept your ${c.kept.join(', ')} (the document changed it too)`) : null);
          })));
      }
      return out;
    };

    // What a sync of an OpenAPI document did, or would do: the versions compared, variables and requests.
    const renderReport = (res, applied) => {
      HD.clear(results);
      const rq = res.requests;
      const spec = res.spec;
      const prev = rq && rq.spec.previous;
      const n = changeCount(res);
      results.appendChild(h('div.section-title', applied ? `Last sync ${src.lastSync ? new Date(src.lastSync.time).toLocaleString() : ''}` : n ? `${plural(n, 'change')} found` : 'No changes'));
      if (spec) {
        results.appendChild(h('div.oas-version',
          h('strong', spec.title || 'Untitled API'), h('span.pill', spec.version || 'no version'), h('span.muted.small', spec.format),
          prev && prev.hash !== spec.hash && prev.version !== spec.version ? h('span.muted.small', `${applied ? 'was' : 'last synced:'} ${prev.version || 'no version'}`) : null));
      }
      if (rq && rq.spec.sameVersion) {
        results.appendChild(h('div.discovery-warning', `The document changed but still says ${versionLabel(spec)}. Ask its owners to raise info.version with each change, so versions can be told apart.`));
      }
      for (const w of res.warnings || []) results.appendChild(h('div.discovery-warning', w));
      if (!applied && !n) {
        results.appendChild(h('div.oas-uptodate', HD.icon('check'), prev ? `Up to date with ${versionLabel(spec)}. Nothing to apply.` : 'Nothing to apply.'));
      }
      // Variables (the base URL, and the token for the operations' auth).
      const d = res.diff;
      if (d) {
        const state = new Map([...d.added.map((k) => [k, 'added']), ...d.updated.map((k) => [k, 'updated']), ...d.removed.map((k) => [k, 'removed'])]);
        const svc = (res.services || [])[0];
        const vars = [...(svc ? [[svc.variable, svc.url]] : []), ...[...state.keys()].filter((k) => !svc || k !== svc.variable).map((k) => [k, k === 'token' || k === 'apiKey' ? '•••• (from the source\'s token)' : ''])];
        results.appendChild(h('div.table-wrap.no-pad', h('table.data-table',
          h('thead', h('tr', h('th', 'Variable'), h('th', 'Value'), h('th', ''))),
          h('tbody', vars.map(([k, v]) => h('tr', h('td.mono', `{{${k}}}`), h('td.mono.break', v), h('td', state.get(k) ? h(`span.pill.${state.get(k)}`, state.get(k)) : null)))))));
      }
      if (rq) {
        if (rq.collection.length) results.appendChild(h('div.muted.small.oas-collection', `Collection: ${rq.collection.join(', ')}`));
        results.append(...changeList(rq, applied));
      } else if (res.operations && src.syncRequests === false) {
        results.appendChild(h('div.muted.small', `${plural(res.operations.length, 'operation')} in the document (keeping a collection is off).`));
      }
      if (!applied && n) {
        results.appendChild(h('div.button-row.oas-apply',
          HD.button(`Apply ${plural(n, 'change')}`, () => apply(spec && spec.hash), { primary: true, icon: 'download' }),
          h('span.muted.small', 'Nothing is written until you apply.')));
      }
      if (src.history && src.history.length) results.appendChild(historyView());
    };

    // Every version applied, newest first.
    const historyView = () => h('div.oas-history',
      h('div.section-title', 'Version history'),
      src.history.map((e) => h('details.oas-group',
        h('summary',
          h('span.pill', (e.spec && e.spec.version) || 'no version'),
          h('span.muted.small', new Date(e.time).toLocaleString()),
          h('span.small', e.requests ? requestSummary(e.requests) : `${plural(e.variables.length, 'variable')} changed`),
          e.sameVersion ? h('span.small.text-warn', 'same version number') : null),
        e.variables.length ? h('div.muted.small', `Variables: ${e.variables.join(', ')}`) : null,
        e.requests ? changeList(e.requests, true) : null)));

    const ls = src.lastSync;
    root.appendChild(h('div.container-view',
      h('div.req-header',
        h('div.breadcrumb', h('span.kind-label', 'Service discovery'),
          h('input.title-input', { 'aria-label': 'Name', value: src.name, spellcheck: 'false', oninput: (e) => {
            src.name = e.target.value;
            touch();
            HD.renderSidebar();
            HD.renderTabBar();
            const help = root.querySelector('.env-target-help');
            if (help && !src.environmentId) help.textContent = `A new environment named "${src.name}" is created on the first sync.`;
          } })),
        ls ? h('span.muted.small', ls.error ? h('span.text-error', `Last sync failed: ${ls.error}`) : `Last synced ${new Date(ls.time).toLocaleString()} · ${plural(ls.count, isOpenApi(src) ? 'operation' : 'service')}`) : null),
      HD.tabStrip([{ id: 'config', label: 'Configuration' }, { id: 'traffic', label: 'Traffic' }], sub, (id) => { tab.ui.sub = id; HD.save(); rerender(); }),
      sub === 'traffic' ? traffic : h('div',
        h('div.panel-pad', h('div.muted.small', p.help)),
        h('div.discovery-layout', config, results))));
    if (sub === 'traffic') renderTraffic();

    if (isOpenApi(src) && ls && !ls.error && ls.spec) {
      renderReport({ spec: ls.spec, requests: ls.requests, diff: ls.diff, services: ls.services, warnings: ls.warnings }, true);
      if (src.available) {
        results.prepend(h('div.discovery-banner.oas-available', HD.icon('search'),
          h('span', `${versionLabel(src.available.spec)} of the document has ${plural(src.available.count, 'change')}.`), h('span.spacer'),
          HD.button('Review', async () => { try { renderReport(await HD.checkDiscovery(src), false); } catch (e) { HD.clear(results).appendChild(h('div.test-script-error', HD.cleanErr(e))); } }, { small: true, primary: true })));
      }
    } else if (isOpenApi(src) && !ls) {
      results.appendChild(h('div.empty-state.small', h('div', 'Enter the document\'s URL (and a token if it needs one), then create the collection and environment.'),
        h('div.muted', 'The server becomes a variable such as {{lots_url}}, and each operation a request that uses it. Later, "Check for changes" compares the new version of the document with the last one and shows what changed before anything is applied.')));
    } else if (ls && !ls.error && ls.diff && tab.ui.showLast !== false) {
      const env = S.ws.environments.find((e) => e.id === src.environmentId);
      if (env && ls.services) {
        renderResults({ services: ls.services, warnings: ls.warnings }, ls.diff);
        results.querySelector('.section-title').textContent = `Last sync: ${ls.services.length} services in "${env.name}"`;
      }
    } else if (!ls) {
      results.appendChild(h('div.empty-state.small', h('div', 'Enter the registry URL, then preview the services or create the environment.'),
        h('div.muted', 'Each service becomes a variable such as {{orders_url}}. Use it in requests: {{orders_url}}/api/orders')));
    }
  };
})();
