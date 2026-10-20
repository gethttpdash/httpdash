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
  });

  HD.openDiscovery = (id) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'discovery' && t.refId === id);
    if (existing) return HD.activateTab(existing.id);
    const cur = HD.currentTab();
    const tab = { id: HD.uid(), kind: 'discovery', refId: id };
    S.ws.tabs.splice(cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length, 0, tab);
    return HD.activateTab(tab.id);
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
        services: res.services.map((s) => ({ name: s.name, variable: s.variable, url: s.url, instances: (s.instances || []).map((i) => ({ healthy: i.healthy })) })),
        spec: res.spec || null, requests: trimReport(rq),
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
        : `${res.services.length} services: ${d.added.length} added, ${d.updated.length} updated, ${d.removed.length} removed`;
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
        onclick: () => HD.openDiscovery(src.id),
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
    { label: 'Edit', onClick: () => HD.openDiscovery(src.id) },
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
    const touch = () => HD.save();
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
        select('addressMode', 'Address to use', [['cluster-dns', 'Cluster DNS (name.namespace.svc.cluster.local)'], ['cluster-ip', 'Cluster IP'], ['external', 'External (LoadBalancer / external IP)']],
          'Cluster DNS and Cluster IP only work from inside the cluster or over a VPN.'),
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
          h('input.title-input', { value: src.name, spellcheck: 'false', oninput: (e) => {
            src.name = e.target.value;
            touch();
            HD.renderSidebar();
            HD.renderTabBar();
            const help = root.querySelector('.env-target-help');
            if (help && !src.environmentId) help.textContent = `A new environment named "${src.name}" is created on the first sync.`;
          } })),
        ls ? h('span.muted.small', ls.error ? h('span.text-error', `Last sync failed: ${ls.error}`) : `Last synced ${new Date(ls.time).toLocaleString()} · ${plural(ls.count, isOpenApi(src) ? 'operation' : 'service')}`) : null),
      h('div.panel-pad', h('div.muted.small', p.help)),
      h('div.discovery-layout', config, results)));

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
