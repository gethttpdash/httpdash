'use strict';

/* The GraphQL body: a query editor that knows the schema (autocomplete, errors, hover info), the
   variables editor, the operation to run, prettify, and a schema explorer. The schema comes from
   introspection, sent like the request itself (its auth, login and certificates), and is kept
   per endpoint, also across restarts. graphql-js and the CodeMirror addons come from
   vendor/graphql.min.js (scripts/vendor-graphql.js). */
(() => {
  const { h } = HD;
  const S = HD.S;
  const G = () => window.HDGraphQL;
  const STORE = 'httpdash.graphqlSchema:';
  const schemas = new Map(); // endpoint key -> { schema, fetched } | { error }

  // A schema is kept per URL as written ({{base_url}}/graphql) and environment.
  const keyFor = (req) => `${req.url.trim()} ${S.ws.activeEnvironmentId || ''}`;
  const schemaFor = (req) => {
    const key = keyFor(req);
    if (!schemas.has(key)) {
      try {
        const saved = localStorage.getItem(STORE + key);
        if (saved) { const s = JSON.parse(saved); schemas.set(key, { schema: G().buildClientSchema(s.data), fetched: s.fetched }); }
      } catch { /* no saved schema, or one that can't be read */ }
    }
    return schemas.get(key) || null;
  };

  // {{variables}} outside strings aren't GraphQL; checking sees a string of the same length instead.
  const maskVariables = (text) => {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') inString = !inString;
      if (!inString && text.startsWith('{{', i)) {
        const end = text.indexOf('}}', i + 2);
        if (end !== -1 && !/[\n{]/.test(text.slice(i + 2, end))) {
          const len = end + 2 - i;
          out += `"${'x'.repeat(len - 2)}"`;
          i = end + 1;
          continue;
        }
      }
      out += c;
    }
    return out;
  };
  const hasBareVariables = (text) => maskVariables(text) !== text;

  /** The operations in the query: [{ type, name }], or null while it doesn't parse. */
  const operationsOf = (query) => {
    try {
      return G().parse(maskVariables(query || '')).definitions
        .filter((d) => d.kind === 'OperationDefinition')
        .map((d) => ({ type: d.operation, name: d.name ? d.name.value : null }));
    } catch { return null; }
  };

  // Each variable's type, for the variables editor's autocomplete and checks.
  const variableTypes = (schema, query) => {
    const out = {};
    try {
      for (const d of G().parse(maskVariables(query || '')).definitions) {
        for (const v of d.variableDefinitions || []) {
          const t = G().typeFromAST(schema, v.type);
          if (t) out[v.variable.name.value] = t;
        }
      }
    } catch { /* keep what we have */ }
    return out;
  };

  /**
   * Draws the GraphQL body into `area`, with its controls added to `bar`.
   * opts: { tab, req, markDirty, introspect: () => Promise<result of a send> }
   */
  HD.graphqlBody = ({ area, bar, tab, req, markDirty, introspect }) => {
    const b = req.body;
    const g = (b.graphql = b.graphql || { query: '', variables: '' });
    const ui = (tab.ui = tab.ui || {});
    if (!G() || !CodeMirror.modes.graphql) {
      // Without the bundle, plain editors still work.
      const split = h('div.graphql-split', h('div.graphql-pane.q', h('div.pane-label', 'Query')), h('div.graphql-pane.v', h('div.pane-label', 'GraphQL Variables (JSON)')));
      area.appendChild(split);
      HD.editor(split.firstChild, { value: g.query, mode: 'javascript', variables: true, onChange: (x) => { g.query = x; markDirty(); } });
      HD.editor(split.lastChild, { value: g.variables, mode: 'json', variables: true, onChange: (x) => { g.variables = x; markDirty(); } });
      return;
    }

    // Toolbar: operation, schema, prettify, explorer.
    const opHost = h('span.gql-op');
    const schemaHost = h('span.gql-schema');
    bar.append(h('span.spacer'), opHost, schemaHost,
      HD.button('Prettify', () => {
        try {
          const pretty = G().print(G().parse(g.query || ''));
          queryCm.setValue(pretty);
          g.query = pretty;
          markDirty();
        } catch (e) { HD.toast(`Could not prettify: ${e.message}${hasBareVariables(g.query) ? ' ({{variables}} outside strings can\'t be prettified)' : ''}`, 'error'); }
      }, { ghost: true, small: true, title: 'Format the query (comments are not kept)' }),
      HD.button('Schema', () => { ui.gqlDocs = !ui.gqlDocs; HD.save(); layout(); }, { ghost: true, small: true, icon: 'layers', title: 'Show or hide the schema explorer', class: ui.gqlDocs ? 'active' : '' }));

    const split = h('div.graphql-split');
    const qPane = h('div.graphql-pane', h('div.pane-label', 'Query'));
    const vPane = h('div.graphql-pane', h('div.pane-label', 'GraphQL Variables (JSON)'));
    const docsPane = h('div.graphql-pane.gql-docs');
    split.append(qPane, vPane, docsPane);
    area.appendChild(split);
    const layout = () => { docsPane.style.display = ui.gqlDocs ? '' : 'none'; bar.querySelectorAll('.btn').forEach((x) => { if (x.title.startsWith('Show or hide the schema')) x.classList.toggle('active', !!ui.gqlDocs); }); if (ui.gqlDocs) renderDocs(); };

    const queryCm = HD.editor(qPane, { value: g.query, mode: 'graphql', variables: true, placeholder: 'query { … }   Fetch the schema for autocomplete (Ctrl+Space).', onChange: (x) => { g.query = x; markDirty(); } });
    const varsCm = HD.editor(vPane, { value: g.variables, mode: 'graphql-variables', variables: true, placeholder: '{ "id": "{{orderId}}" }', onChange: (x) => { g.variables = x; markDirty(); } });

    // Autocomplete as you type a name, but not inside {{…}}, which has its own suggestions.
    const autoHint = (cm, e) => {
      if (cm.state.completionActive || !/^[A-Za-z0-9_@($]$/.test(e.key)) return;
      const cur = cm.getCursor();
      const before = cm.getLine(cur.line).slice(0, cur.ch);
      if (/\{\{[^}]*$/.test(before)) return;
      cm.showHint({ completeSingle: false, container: document.body });
    };
    queryCm.on('change', () => afterQuery()); // typing, and also Prettify or a version switched to
    queryCm.on('keyup', autoHint);
    varsCm.on('keyup', autoHint);
    for (const cm of [queryCm, varsCm]) cm.setOption('extraKeys', { ...cm.getOption('extraKeys'), 'Ctrl-Space': () => cm.showHint({ completeSingle: true }) });

    // The schema reaches the editors' autocomplete, checks and hover info.
    const applySchema = () => {
      const entry = schemaFor(req);
      const schema = entry && entry.schema;
      queryCm.setOption('hintOptions', { schema, closeOnUnfocus: true, completeSingle: false });
      queryCm.setOption('info', schema ? { schema, onClick: (ref) => showRef(ref) } : false);
      queryCm.setOption('lint', schema ? { schema, getAnnotations: (text, opts, cm) => CodeMirror.helpers.lint.graphql(maskVariables(text), opts, cm) } : false);
      applyVariableTypes();
      drawSchemaState();
      if (ui.gqlDocs) renderDocs();
    };
    const applyVariableTypes = () => {
      const entry = schemaFor(req);
      const variableToType = entry && entry.schema ? variableTypes(entry.schema, g.query) : {};
      varsCm.setOption('hintOptions', { variableToType, closeOnUnfocus: true, completeSingle: false });
      varsCm.setOption('lint', entry && entry.schema && !hasBareVariables(g.variables || '') ? { variableToType } : false);
    };

    const drawSchemaState = () => {
      HD.clear(schemaHost);
      const entry = schemaFor(req);
      const label = !entry ? 'No schema' : entry.loading ? 'Fetching schema…' : entry.error ? 'Schema failed' : `Schema · ${Object.keys(entry.schema.getTypeMap()).filter((n) => !n.startsWith('__')).length} types`;
      schemaHost.append(
        h('span.gql-schema-state', { class: entry && entry.error ? 'text-error' : 'muted', title: entry && entry.error ? entry.error : entry && entry.fetched ? `Fetched ${new Date(entry.fetched).toLocaleString()} by introspection` : 'Fetch it to get autocomplete, error checking and the explorer' }, label),
        HD.button(entry && entry.schema ? '' : 'Fetch schema', () => fetchSchema(), { ghost: true, small: true, icon: 'refresh', disabled: !!(entry && entry.loading), title: `${entry && entry.schema ? 'Fetch the schema again' : 'Ask the endpoint for its schema'} (introspection), with this request's auth` }));
    };

    const fetchSchema = async () => {
      if (!req.url.trim()) { HD.toast('Enter the GraphQL endpoint URL first', 'warn'); return; }
      const key = keyFor(req);
      const old = schemas.get(key);
      schemas.set(key, { ...(old && old.schema ? old : {}), loading: true });
      drawSchemaState();
      let entry;
      try {
        const result = await introspect(G().getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true }));
        if (result.error) throw new Error(result.error);
        let body;
        try { body = JSON.parse(result.response.bodyText); } catch { throw new Error(`The endpoint answered ${result.response.status} without JSON`); }
        if (!body.data || !body.data.__schema) throw new Error((body.errors && body.errors[0] && body.errors[0].message) || `The endpoint answered ${result.response.status} without a schema`);
        entry = { schema: G().buildClientSchema(body.data), fetched: Date.now() };
        try { localStorage.setItem(STORE + key, JSON.stringify({ data: body.data, fetched: entry.fetched })); } catch { /* too big to keep: this session only */ }
        HD.toast('Schema fetched: autocomplete and checks are on', 'success', 1800);
      } catch (e) {
        entry = { ...(old && old.schema ? old : {}), error: `Introspection failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` };
        HD.toast(entry.error, 'error');
      }
      schemas.set(key, entry);
      applySchema();
      queryCm.performLint && queryCm.performLint();
    };

    // The operation to run: picked when the document has several (sent as operationName).
    const drawOperations = () => {
      HD.clear(opHost);
      const ops = operationsOf(g.query);
      if (!ops) return;
      const named = ops.filter((o) => o.name);
      if (ops.length < 2) {
        if (g.operationName) { delete g.operationName; markDirty(); }
        if (ops.length === 1 && ops[0].type === 'subscription') opHost.append(h('span.gql-sub', { title: 'Sent over a WebSocket (graphql-transport-ws); results arrive in the Events view until you press Stop' }, 'Subscription'));
        return;
      }
      if (!named.some((o) => o.name === g.operationName)) { g.operationName = named.length ? named[0].name : undefined; markDirty(); }
      const sel = HD.select(named.map((o) => [o.name, `${o.type} ${o.name}`]), g.operationName || '', (v) => { g.operationName = v; markDirty(); drawOperations(); }, 'select-small gql-op-select');
      sel.title = 'The operation to run (sent as operationName)';
      opHost.append(sel);
      const op = named.find((o) => o.name === g.operationName);
      if (op && op.type === 'subscription') opHost.append(h('span.gql-sub', { title: 'Sent over a WebSocket (graphql-transport-ws); results arrive in the Events view until you press Stop' }, 'Subscription'));
    };
    const afterQuery = HD.debounce(() => { drawOperations(); applyVariableTypes(); }, 250);

    // ---- Schema explorer --------------------------------------------------------------------
    ui.gqlPath = ui.gqlPath || [];
    let filter = '';
    const typeLink = (t) => {
      const named = G().getNamedType(t);
      const text = String(t);
      const i = text.indexOf(named.name);
      return h('span.gql-type', text.slice(0, i), h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = [...ui.gqlPath, named.name]; HD.save(); renderDocs(); } }, named.name), text.slice(i + named.name.length));
    };
    const showRef = (ref) => {
      const name = ref.type ? G().getNamedType(ref.type).name : ref.parentType ? G().getNamedType(ref.parentType).name : null;
      if (!name) return;
      ui.gqlDocs = true;
      ui.gqlPath = [name];
      HD.save();
      layout();
    };
    const insert = (text) => { queryCm.replaceSelection(text); queryCm.focus(); };
    const renderDocs = () => {
      HD.clear(docsPane);
      const entry = schemaFor(req);
      if (!entry || !entry.schema) {
        docsPane.append(h('div.pane-label', 'Schema'), h('div.empty-state.small', entry && entry.error ? entry.error : 'Fetch the schema to browse its types and fields.'));
        return;
      }
      const schema = entry.schema;
      const search = h('input.input.gql-docs-search', { type: 'search', placeholder: 'Search types and fields', value: filter, spellcheck: 'false', oninput: HD.debounce((e) => { filter = e.target.value.trim().toLowerCase(); draw(); }, 150) });
      const body = h('div.gql-docs-body');
      docsPane.append(h('div.pane-label', 'Schema'), h('div.gql-docs-top', search), body);
      const crumbs = () => h('div.gql-crumbs',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = []; HD.save(); renderDocs(); } }, 'Root'),
        ...ui.gqlPath.flatMap((n, i) => [' / ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = ui.gqlPath.slice(0, i + 1); HD.save(); renderDocs(); } }, n)]));
      const fieldRow = (f) => h('div.gql-field',
        h('div', h('a.gql-field-name', { href: '#', title: 'Insert into the query', onclick: (e) => { e.preventDefault(); insert(f.name); } }, f.name),
          f.args && f.args.length ? ['(', ...f.args.flatMap((a, i) => [i ? ', ' : '', h('span.gql-arg', a.name), ': ', typeLink(a.type)]), ')'] : null,
          ': ', typeLink(f.type), f.deprecationReason ? h('span.pill.gql-deprecated', { title: f.deprecationReason }, 'deprecated') : null),
        f.description ? h('div.gql-desc', f.description) : null);
      const draw = () => {
        HD.clear(body);
        if (filter) {
          const hits = [];
          for (const t of Object.values(schema.getTypeMap())) {
            if (t.name.startsWith('__')) continue;
            if (t.name.toLowerCase().includes(filter)) hits.push(h('div.gql-field', h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = [t.name]; filter = ''; HD.save(); renderDocs(); } }, t.name), h('span.muted.small', ` ${kind(t)}`)));
            const fields = t.getFields ? Object.values(t.getFields()) : [];
            for (const f of fields) if (f.name.toLowerCase().includes(filter)) hits.push(h('div.gql-field', h('span.muted', `${t.name}.`), h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = [t.name]; filter = ''; HD.save(); renderDocs(); } }, f.name), ': ', typeLink(f.type)));
            if (hits.length > 200) break;
          }
          body.append(...(hits.length ? hits : [h('div.muted.small', 'Nothing matches.')]));
          return;
        }
        body.appendChild(crumbs());
        const name = ui.gqlPath[ui.gqlPath.length - 1];
        const t = name && schema.getType(name);
        if (!t) {
          const roots = [['Query', schema.getQueryType()], ['Mutation', schema.getMutationType()], ['Subscription', schema.getSubscriptionType()]].filter(([, x]) => x);
          body.append(...roots.map(([label, x]) => h('div.gql-field', h('span.muted', `${label}: `), h('a', { href: '#', onclick: (e) => { e.preventDefault(); ui.gqlPath = [x.name]; HD.save(); renderDocs(); } }, x.name))));
          return;
        }
        body.append(h('div.gql-type-head', h('b', t.name), h('span.muted.small', ` ${kind(t)}`)));
        if (t.description) body.append(h('div.gql-desc', t.description));
        if (t.getFields) body.append(...Object.values(t.getFields()).map(fieldRow));
        if (t.getValues) body.append(...t.getValues().map((v) => h('div.gql-field', h('a.gql-field-name', { href: '#', onclick: (e) => { e.preventDefault(); insert(v.name); } }, v.name), v.description ? h('div.gql-desc', v.description) : null)));
        if (t.getTypes) body.append(h('div.muted.small', 'One of: '), ...t.getTypes().map((x) => h('div.gql-field', typeLink(x))));
        if (t.getInterfaces && t.getInterfaces().length) body.append(h('div.muted.small', 'Implements: ', ...t.getInterfaces().flatMap((x, i) => [i ? ', ' : '', typeLink(x)])));
      };
      draw();
    };
    const kind = (t) => (G().isObjectType(t) ? 'type' : G().isInputObjectType(t) ? 'input' : G().isEnumType(t) ? 'enum' : G().isInterfaceType(t) ? 'interface' : G().isUnionType(t) ? 'union' : 'scalar');

    applySchema();
    drawOperations();
    layout();
  };
})();
