'use strict';

/*
 * Request versions: every distinct version of a request sent by hand from the editor, with the
 * response it got, so you can switch between them, name and tag them, and find them in search.
 * Runs and monitors don't add versions. They are personal working history: kept in the workspace
 * (S.ws.requestVersions, by request id), not in the collection, so they aren't exported or shared.
 *
 * Also: whether a request (or a version) still fits its operation in an OpenAPI source's spec.
 */
(() => {
  const { h } = HD;
  const S = HD.S;

  const MAX_VERSIONS = 50;
  const MAX_BODY = 64 * 1024;

  const store = () => (S.ws.requestVersions = S.ws.requestVersions || {});
  // Versions of an unsaved request are kept under its tab until it is saved.
  HD.versionKey = (tab) => {
    const s = store();
    if (tab.refId && s[`tab:${tab.id}`]) {
      s[tab.refId] = [...(s[tab.refId] || []), ...s[`tab:${tab.id}`]];
      delete s[`tab:${tab.id}`];
    }
    return tab.refId || `tab:${tab.id}`;
  };
  HD.versionsOf = (key) => store()[key] || [];

  // What was sent, reduced to what matters: the same request sent again is the same version.
  const rows = (list) => (list || []).filter((r) => r.key && r.enabled !== false).map((r) => [r.key, r.value == null ? '' : String(r.value)]);
  const sentShape = (def) => {
    const b = def.body || {};
    const mode = b.mode || 'none';
    const body = mode === 'raw' ? [b.rawLanguage || '', b.raw || ''] : mode === 'urlencoded' || mode === 'formdata' ? rows(b[mode]) : mode === 'graphql' ? b.graphql : mode === 'binary' ? b.binary : null;
    return { method: String(def.method || 'GET').toUpperCase(), url: def.url || '', pathVariables: rows(def.pathVariables), headers: rows(def.headers), body: [mode, body], auth: def.auth || null };
  };
  // A 53-bit hash (cyrb53) of the shape's JSON: short keys, few collisions.
  const hash = (str) => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  HD.versionPrint = (def) => hash(JSON.stringify(sentShape(def)));
  const snapshot = (def) => HD.clone({ method: def.method, url: def.url, params: def.params || [], pathVariables: def.pathVariables || [], headers: def.headers || [], body: def.body, auth: def.auth });
  const keepResponse = (result) => {
    const r = result && result.response;
    if (!r) return result && result.error ? { error: result.error } : null;
    const body = String(r.bodyText || '');
    return {
      status: r.status, statusText: r.statusText, time: r.time, size: r.size, bodySize: r.bodySize, headersSize: r.headersSize,
      contentType: r.contentType, headers: r.headers, httpVersion: r.httpVersion, bodyText: body.slice(0, MAX_BODY), ...(body.length > MAX_BODY ? { truncated: true } : {}),
    };
  };

  /** Keeps what a manual send sent, with its response. Returns the version. */
  HD.recordVersion = (tab, def, result) => {
    const key = HD.versionKey(tab);
    const list = (store()[key] = HD.versionsOf(key));
    const fp = HD.versionPrint(def);
    let v = list.find((x) => x.fp === fp);
    const now = Date.now();
    if (v) {
      v.lastSent = now;
      v.sends = (v.sends || 1) + 1;
      v.response = keepResponse(result);
    } else {
      v = { id: HD.uid(), name: '', tags: [], fp, request: snapshot(def), firstSent: now, lastSent: now, sends: 1, response: keepResponse(result) };
      list.push(v);
      // Keep the newest; versions given a name or tags are the last to go.
      while (list.length > MAX_VERSIONS) {
        const plain = list.filter((x) => !x.name && !(x.tags || []).length).sort((a, b) => a.lastSent - b.lastSent)[0];
        const drop = plain || [...list].sort((a, b) => a.lastSent - b.lastSent)[0];
        list.splice(list.indexOf(drop), 1);
      }
    }
    HD.save();
    return v;
  };

  /** A version's name, or a description of how it differs (method, URL, and its body if that's what differs). */
  HD.versionLabel = (v, list = []) => {
    if (v.name) return v.name;
    const r = v.request;
    const url = String(r.url || '').replace(/^\{\{[^}]+\}\}/, '');
    const base = `${String(r.method || 'GET').toUpperCase()} ${url || '/'}`;
    const same = list.filter((x) => x !== v && !x.name && `${x.request.method} ${x.request.url}` === `${r.method} ${r.url}`);
    const raw = r.body && r.body.mode === 'raw' ? String(r.body.raw || '').replace(/\s+/g, ' ').trim() : '';
    return same.length && raw ? `${base} · ${raw.slice(0, 40)}${raw.length > 40 ? '…' : ''}` : base;
  };

  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  HD.versionAgo = ago;

  /** Loads a version into a request tab: what it sent, and the response it got. */
  HD.useVersion = (tab, v) => {
    const req = tab.draft.request;
    const s = HD.clone(v.request);
    for (const k of ['method', 'url', 'params', 'pathVariables', 'headers', 'body', 'auth']) if (k in s) req[k] = s[k];
    tab.dirty = true;
    if (v.response) {
      S.responses.set(tab.id, v.response.error
        ? { error: v.response.error, tests: [], fromVersion: { name: HD.versionLabel(v, HD.versionsOf(HD.versionKey(tab))), time: v.lastSent } }
        : { response: { ...v.response }, tests: [], fromVersion: { name: HD.versionLabel(v, HD.versionsOf(HD.versionKey(tab))), time: v.lastSent } });
    }
    HD.save();
    HD.renderTabBar();
    if (HD.currentTab() === tab) HD.renderActiveTab();
  };

  /** The version a request's draft is right now, if it is one. */
  HD.currentVersion = (tab) => {
    const list = HD.versionsOf(HD.versionKey(tab));
    if (!list.length) return null;
    const fp = HD.versionPrint(tab.draft.request);
    return list.find((v) => v.fp === fp) || null;
  };

  // ---- Fits the spec? -------------------------------------------------------------------------

  /**
   * Whether a request definition still fits its operation in an OpenAPI source's spec:
   * { source, spec, key, missing, issues } or null when no OpenAPI source covers it.
   */
  HD.specCheck = async (def, itemId) => {
    const f = itemId ? HD.find(itemId) : null;
    const op = f && f.node.openapi && f.node.openapi.op;
    for (const src of HD.discoverySources ? HD.discoverySources() : []) {
      const ls = src.lastSync;
      if (src.provider !== 'openapi' || !ls || !ls.shapes) continue;
      const fromIt = op && f.collection.id === src.collectionId;
      const variable = ls.services && ls.services[0] && ls.services[0].variable;
      if (!fromIt && !(variable && new RegExp(`^\\{\\{\\s*${variable}\\s*\\}\\}`).test(def.url || ''))) continue;
      const res = await window.api.checkShape({ def: HD.clone(def), shapes: ls.shapes, op: fromIt ? op : undefined, variable });
      if (res) return { ...res, source: src.name, spec: ls.spec };
    }
    return null;
  };
  const specName = (c) => `${c.spec && c.spec.title ? c.spec.title : c.source}${c.spec && c.spec.version ? ` ${c.spec.version}` : ''}`;
  /** One sentence for a check's result, or null when the request fits. */
  HD.specProblem = (c) => {
    if (!c) return null;
    if (c.missing) return `${c.key} is not in ${specName(c)} any more`;
    if (!c.issues.length) return null;
    const said = c.issues.length <= 2 ? c.issues.map((i) => i.message).join('; ') : `${c.issues[0].message}, and ${c.issues.length - 1} more`;
    return `${said} (${specName(c)})`;
  };
  /** The banner above a request when it doesn't fit its spec. */
  HD.specBanner = (c) => {
    if (!c || (!c.missing && !c.issues.length)) return null;
    const bad = c.missing || c.issues.some((i) => i.level === 'error');
    return h(`div.spec-banner.${bad ? 'bad' : 'warn'}`, HD.icon('alert'),
      h('div',
        h('div.spec-banner-title', c.missing ? `${c.key} is not in ${specName(c)} any more` : `This request doesn't fit ${specName(c)}`),
        c.issues.length ? h('ul', c.issues.slice(0, 6).map((i) => h('li', i.message))) : h('div.muted.small', 'The operation was removed or renamed in the spec. Check the service\'s discovery source for what replaced it.')));
  };

  // ---- Menu and panel -------------------------------------------------------------------------

  /** The versions menu: newest first, each with its last status; picking one loads it. */
  HD.versionsMenu = async (e, tab) => {
    const list = HD.versionsOf(HD.versionKey(tab)).slice().sort((a, b) => b.lastSent - a.lastSent);
    const current = HD.currentVersion(tab);
    const anchor = e && e.currentTarget ? e.currentTarget : e;
    const checks = await Promise.all(list.map((v) => HD.specCheck(v.request, tab.refId).catch(() => null)));
    HD.menu(anchor, [
      ...list.slice(0, 15).map((v, i) => ({
        label: `${HD.specProblem(checks[i]) ? '⚠ ' : ''}${HD.versionLabel(v, list)}${(v.tags || []).length ? `  ${v.tags.map((t) => `#${t}`).join(' ')}` : ''}`,
        hint: `${v.response && v.response.status ? v.response.status : v.response && v.response.error ? 'error' : ''} · ${ago(v.lastSent)}`,
        checked: current === v,
        onClick: () => HD.useVersion(tab, v),
      })),
      list.length > 15 ? { label: `${list.length - 15} older…`, onClick: () => HD.manageVersions(tab) } : null,
      { separator: true },
      { label: 'Manage versions…', onClick: () => HD.manageVersions(tab) },
    ]);
  };

  /** Rename, tag, use or delete versions; see which no longer fit the spec. */
  HD.manageVersions = (tab) => {
    const key = HD.versionKey(tab);
    const body = h('div.versions');
    const draw = async () => {
      const list = HD.versionsOf(key).slice().sort((a, b) => b.lastSent - a.lastSent);
      const current = HD.currentVersion(tab);
      HD.clear(body);
      body.appendChild(h('div.muted.small.versions-help', 'Every version of this request you sent by hand, with the response it got. Runs don\'t add versions. Name and tag the ones worth keeping: they are the last to go when there are more than 50, and you can find them in the sidebar search.'));
      if (!list.length) { body.appendChild(h('div.empty-state.small', 'No versions yet: send the request.')); return; }
      const checks = await Promise.all(list.map((v) => HD.specCheck(v.request, tab.refId).catch(() => null)));
      body.appendChild(h('div.versions-list', list.map((v, i) => {
        const problem = HD.specProblem(checks[i]);
        return h('div.version-row', { class: current === v ? 'current' : '' },
          h('div.version-main',
            h('input.input.version-name', { value: v.name || '', placeholder: HD.versionLabel({ ...v, name: '' }, list), spellcheck: 'false', 'aria-label': 'Version name',
              onchange: (e) => { v.name = e.target.value.trim(); HD.save(); HD.renderSidebar(); } }),
            HD.tagInput({ tags: (v.tags = v.tags || []), onChange: () => { HD.save(); HD.renderSidebar(); } }),
            h('div.version-meta.muted.small',
              v.response && v.response.status ? h(`span.${HD.statusClass(v.response.status)}`, `${v.response.status} ${v.response.statusText || ''}`) : v.response && v.response.error ? h('span.text-error', 'error') : null,
              ` · sent ${v.sends || 1}× · last ${ago(v.lastSent)}`,
              current === v ? h('span.pill.added', 'in the editor') : null),
            problem ? h('div.version-warn', HD.icon('alert'), problem) : null),
          h('div.version-actions',
            HD.button('Use', () => { HD.useVersion(tab, v); draw(); }, { small: true, disabled: current === v }),
            HD.button('', async () => {
              if (!(await HD.confirm('Delete version', `Delete "${HD.versionLabel(v, list)}"?`, { danger: true, okLabel: 'Delete' }))) return;
              const all = HD.versionsOf(key);
              all.splice(all.indexOf(v), 1);
              HD.save();
              HD.renderSidebar();
              draw();
            }, { small: true, ghost: true, icon: 'trash', title: 'Delete' })));
      })));
    };
    HD.modal({ title: `Versions of ${tab.draft.name}`, body, width: 860, onClose: () => { if (HD.currentTab() === tab) HD.renderActiveTab(); } });
    draw();
  };
})();
