'use strict';

/* Modal dialogs: code generation, import, settings, cookies, save-as and environment quick look. */
(() => {
  const { h } = HD;
  const S = HD.S;
  const cleanErr = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  HD.cleanErr = cleanErr;

  // ---- Code generation ----------------------------------------------------------------------

  HD.showCodegen = async (tab) => {
    if (!tab || tab.kind !== 'request') return;
    const targets = await window.api.codegenTargets();
    let target = S.ws.ui.codegenTarget || 'curl';
    const found = HD.find(tab.refId);
    const chain = found ? [found.collection, ...found.parents].map((n) => ({ auth: n.auth })) : [];
    const scopes = HD.scopesFor(found ? found.collection : null);
    const host = h('div.codegen-editor');
    let cm;
    const generate = async () => {
      try {
        const code = await window.api.generateCode({ target, request: HD.clone(tab.draft.request), chain, scopes });
        if (!cm) cm = HD.editor(host, { value: code, mode: targets.find((t) => t.id === target).lang, readOnly: true });
        else {
          cm.setValue(code);
          HD.setEditorMode(cm, targets.find((t) => t.id === target).lang);
        }
      } catch (e) {
        const msg = `// Could not generate code: ${cleanErr(e)}`;
        if (cm) cm.setValue(msg); else cm = HD.editor(host, { value: msg, readOnly: true });
      }
    };
    HD.modal({
      title: 'Code snippet',
      width: 820,
      body: h('div.codegen',
        h('div.codegen-bar',
          HD.select(targets.map((t) => [t.id, t.label]), target, (v) => { target = v; S.ws.ui.codegenTarget = v; HD.save(); generate(); }),
          h('span.muted.small', 'Variables are resolved using the active environment.'),
          h('span.spacer'),
          HD.button('Copy', () => HD.copy(cm.getValue()), { icon: 'copy', small: true })),
        host),
    });
    generate();
  };

  // ---- Import -------------------------------------------------------------------------------

  HD.applyImport = (items) => {
    let n = 0;
    for (const it of items) {
      if (it.error) { HD.toast(`${it.file || 'Import'}: ${it.error}`, 'error', 6000); continue; }
      if (it.kind === 'backup') { HD.importBackup(it); n++; continue; }
      if (it.kind === 'collection') { S.ws.collections.push(it.data); n++; }
      if (it.kind === 'environment') { S.ws.environments.push(it.data); n++; }
      if (it.kind === 'globals') {
        // Update existing global keys instead of adding duplicates.
        for (const g of it.data) {
          const existing = S.ws.globals.find((x) => x.key === g.key);
          if (existing) Object.assign(existing, g); else S.ws.globals.push(g);
        }
        n++;
      }
      HD.toast(`Imported ${it.kind}${it.data && it.data.name ? ` "${it.data.name}"` : ''}`, 'success');
    }
    if (n) { HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); }
    return n;
  };

  HD.showImport = () => {
    const ta = h('textarea.input.import-text', { placeholder: 'Paste a cURL command, an HttpDash backup, a Postman collection / environment, or an OpenAPI / Swagger document (JSON or YAML)…', spellcheck: 'false' });
    const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); fromLink(); } };
    const link = h('input.input.import-link', { type: 'url', placeholder: 'https://api.example.com/openapi.json', spellcheck: 'false', onkeydown: onEnter });
    // Only used to fetch the document; it isn't saved.
    const linkToken = h('input.input.import-token', { type: 'password', placeholder: 'Bearer token (optional)', spellcheck: 'false', autocomplete: 'off', onkeydown: onEnter });
    const fromLink = async () => {
      const url = link.value.trim();
      if (!url) return false;
      try {
        const r = await window.api.importUrl({ url, token: linkToken.value.trim(), settings: S.ws.settings });
        if (HD.applyImport([r]) > 0) { m.close(); return true; }
      } catch (e) {
        HD.toast(`Import failed: ${cleanErr(e)}`, 'error', 6000);
      }
      return false;
    };
    const m = HD.modal({
      title: 'Import',
      width: 640,
      body: h('div.import',
        h('div.drop-zone',
          h('div', 'Drop files anywhere in the window, or'),
          HD.button('Choose files…', async () => {
            const items = await window.api.importFiles();
            if (HD.applyImport(items)) m.close();
          }, { primary: true, icon: 'upload' }),
          h('div.muted.small', 'HttpDash backups, Postman collections (v2.0 / v2.1), environments and globals, OpenAPI 3 / Swagger 2 (JSON or YAML). Select several files at once to import a whole Postman export folder.')),
        h('div.or', 'or import from a link'),
        h('div.import-link-row', link, HD.revealable(linkToken), HD.button('Fetch', () => fromLink(), { small: true })),
        h('div.or', 'or paste raw text'),
        ta),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Import', primary: true,
          onClick: async () => {
            if (link.value.trim() && !ta.value.trim()) return fromLink();
            const text = ta.value.trim();
            if (!text) return false;
            try {
              if (/^curl\s/i.test(text)) {
                const req = await window.api.importCurl(text);
                HD.openNewRequest(req, req.url.replace(/^https?:\/\//, '').split('?')[0].slice(0, 60));
                return true;
              }
              const r = await window.api.importText(text);
              return HD.applyImport([r]) > 0;
            } catch (e) {
              HD.toast(`Import failed: ${cleanErr(e)}`, 'error', 6000);
              return false;
            }
          },
        },
      ],
    });
  };

  // Drag & drop import.
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer.files || [])];
    for (const f of files) {
      try {
        const r = await window.api.importText(await f.text());
        HD.applyImport([{ ...r, file: f.name }]);
      } catch (err) {
        HD.toast(`${f.name}: ${cleanErr(err)}`, 'error', 6000);
      }
    }
  });

  // ---- Save as ------------------------------------------------------------------------------

  // Resolves to { collectionId, folderId, name } or null.
  HD.pickLocation = (title, name) => new Promise((resolve) => {
    let done = false;
    let selected = null;
    const nameInput = h('input.input', { value: name || '' });
    const tree = h('div.location-tree');
    const renderTree = () => {
      HD.clear(tree);
      if (!S.ws.collections.length) tree.appendChild(h('div.muted.small.panel-pad', 'No collections yet — one will be created.'));
      const row = (node, depth, colId) => {
        const isSel = selected && selected.id === node.id;
        tree.appendChild(h('div.location-row', {
          class: isSel ? 'selected' : '', style: { paddingLeft: `${8 + depth * 16}px` },
          onclick: () => { selected = { id: node.id, collectionId: colId, folderId: node.type === 'folder' ? node.id : null }; renderTree(); },
        }, HD.icon(node.type === 'collection' ? 'layers' : 'folder'), node.name));
        for (const c of node.items || []) if (c.type === 'folder') row(c, depth + 1, colId);
      };
      S.ws.collections.forEach((c) => row(c, 0, c.id));
    };
    if (S.ws.collections[0]) selected = { id: S.ws.collections[0].id, collectionId: S.ws.collections[0].id, folderId: null };
    renderTree();
    HD.modal({
      title,
      width: 480,
      body: h('div', h('label.field', h('span', 'Request name'), nameInput), h('div.field', h('span', 'Save to'), tree),
        HD.button('New collection', async () => {
          const n = await HD.prompt('New collection', 'Name', 'New Collection');
          if (!n) return;
          const c = HD.newCollection(n);
          S.ws.collections.push(c);
          HD.save();
          HD.renderSidebar();
          selected = { id: c.id, collectionId: c.id, folderId: null };
          renderTree();
        }, { small: true, ghost: true, icon: 'plus' })),
      buttons: [
        { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
        {
          label: 'Save', primary: true,
          onClick: () => {
            if (!selected) {
              const c = HD.newCollection('My Collection');
              S.ws.collections.push(c);
              selected = { collectionId: c.id, folderId: null };
            }
            done = true;
            resolve({ ...selected, name: nameInput.value.trim() || 'Untitled Request' });
          },
        },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });

  // ---- Settings -----------------------------------------------------------------------------

  HD.showSettings = async (initialSection) => {
    const s = S.ws.settings;
    const info = await window.api.appInfo();
    const toggle = (key, label, help) => h('div.setting-row',
      h('div', h('div.setting-label', label), help ? h('div.setting-help', help) : null),
      h('label.switch', h('input', { type: 'checkbox', checked: s[key] !== false, onchange: (e) => { s[key] = e.target.checked; HD.save(); } }), h('span.slider')));
    const num = (key, label, help, obj = s) => h('div.setting-row',
      h('div', h('div.setting-label', label), help ? h('div.setting-help', help) : null),
      h('input.input.input-small', { type: 'number', min: 0, value: obj[key] == null ? '' : obj[key], oninput: (e) => { obj[key] = e.target.value === '' ? 0 : Number(e.target.value); HD.save(); } }));
    const text = (key, label, help, obj = s, type = 'text') => h('div.setting-row',
      h('div', h('div.setting-label', label), help ? h('div.setting-help', help) : null),
      h('input.input.input-med', { type, value: obj[key] || '', oninput: (e) => { obj[key] = e.target.value; HD.save(); } }));
    const p = s.proxy;
    let section = initialSection || 'general';
    const body = h('div.settings');
    const render = () => {
      HD.clear(body);
      const nav = HD.tabStrip([{ id: 'general', label: 'General' }, { id: 'proxy', label: 'Proxy' }, { id: 'certificates', label: 'Certificates' }, { id: 'appearance', label: 'Appearance' }, { id: 'security', label: 'Security' }, { id: 'ai', label: 'AI access' }, { id: 'data', label: 'Data' }, { id: 'about', label: 'About' }], section, (id) => { section = id; render(); });
      const panel = h('div.settings-panel');
      if (section === 'general') {
        panel.append(
          num('timeout', 'Request timeout (ms)', 'How long to wait for a response. 0 means wait forever.'),
          toggle('followRedirects', 'Automatically follow redirects', 'Follow 3xx responses.'),
          num('maxRedirects', 'Maximum number of redirects'),
          toggle('verifySSL', 'SSL certificate verification', 'Turn off to allow self-signed or expired certificates.'),
          toggle('reuseConnections', 'Reuse connections (keep-alive)', 'Requests to a host you just called skip DNS, TCP and the TLS handshake. Turn off to open a new connection for every request.'),
          toggle('traceNetwork', 'Trace where requests go on the network', 'For each request: the addresses its host name resolves to, the one it connected to with its segment and reverse-DNS name, and the network adapter it left from (Timeline → Network).'),
          h('div.setting-row', h('div', h('div.setting-label', 'Network segment size'), h('div.setting-help', 'How addresses are grouped into segments, in the Timeline and in Traffic by segment.')),
            h('div.button-row.flush',
              HD.select([8, 16, 20, 22, 24, 26, 28].map((n) => [n, `IPv4 /${n}`]), s.segmentBits4 || 24, (v) => { s.segmentBits4 = Number(v); HD.save(); }, 'select-small'),
              HD.select([32, 48, 56, 64].map((n) => [n, `IPv6 /${n}`]), s.segmentBits6 || 64, (v) => { s.segmentBits6 = Number(v); HD.save(); }, 'select-small'))),
          toggle('sendCookies', 'Use cookie jar', 'Send stored cookies and store cookies from responses.'),
          toggle('sendNoCache', 'Send no-cache header', 'Adds "Cache-Control: no-cache" to requests.'),
          text('userAgent', 'User-Agent', 'Default User-Agent header.'),
          num('maxResponseBytes', 'Max response size (bytes)', 'Abort downloads larger than this. 0 means unlimited.'),
          num('largeResponseBytes', 'Large response size (bytes)', 'Larger responses show only their first 512 KB until you click "Show all". 0 always shows everything.'),
          num('historyLimit', 'History entries to keep'));
      } else if (section === 'proxy') {
        panel.append(
          h('div.setting-row', h('div', h('div.setting-label', 'Use custom proxy'), h('div.setting-help', 'HTTP proxy for HTTP and HTTPS (CONNECT) requests.')),
            h('label.switch', h('input', { type: 'checkbox', checked: !!p.enabled, onchange: (e) => { p.enabled = e.target.checked; HD.save(); } }), h('span.slider'))),
          text('host', 'Proxy host', 'e.g. 127.0.0.1', p),
          num('port', 'Proxy port', null, p),
          text('username', 'Username (optional)', null, p),
          text('password', 'Password (optional)', null, p, 'password'),
          text('bypass', 'Bypass for hosts', 'Comma-separated, supports *.example.com', p));
      } else if (section === 'certificates') {
        renderCertificates(panel, s, render);
      } else if (section === 'appearance') {
        panel.append(
          h('div.setting-row', h('div', h('div.setting-label', 'Theme')), HD.select([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], s.theme || 'system', (v) => { s.theme = v; HD.save(); HD.applyTheme(); })),
          h('div.setting-row', h('div', h('div.setting-label', 'Editor font size')), HD.select([11, 12, 13, 14, 15, 16].map((n) => [n, `${n}px`]), s.fontSize || 13, (v) => { s.fontSize = Number(v); HD.save(); HD.applyTheme(); })),
          h('div.setting-row', h('div', h('div.setting-label', 'Request / response layout')), HD.select([['vertical', 'Stacked (response below)'], ['horizontal', 'Side by side']], S.ws.ui.layout || 'vertical', (v) => { S.ws.ui.layout = v; HD.save(); HD.renderActiveTab(); })));
      } else if (section === 'ai') {
        HD.aiSettingsPanel(panel, render);
      } else if (section === 'security') {
        HD.renderSecuritySettings(panel);
      } else if (section === 'data') {
        panel.append(
          h('div.setting-row', h('div', h('div.setting-label', 'Export all'), h('div.setting-help', 'Back up everything to one file, or export all collections and environments in Postman format. Restore a backup with Import.')), HD.button('Export all…', () => HD.showExportAll(), { small: true })),
          h('div.setting-row', h('div', h('div.setting-label', 'Clear history')), HD.button('Clear', async () => { if (await HD.confirm('Clear history', 'Delete all history entries?', { danger: true, okLabel: 'Clear' })) { S.ws.history = []; HD.save(); HD.emit('history'); } }, { small: true, danger: true })),
          h('div.setting-row', h('div', h('div.setting-label', 'Data folder'), h('div.setting-help.mono', info.dataDir))));
      } else {
        panel.append(h('div.about', h('div.about-name', 'HttpDash'), h('div', `Version ${info.version}`), h('div.muted', 'Free to use, source available. Functional Source License (FSL-1.1-ALv2).')));
      }
      body.append(nav, panel);
    };
    render();
    HD.modal({ title: 'Settings', body, width: 680, onClose: () => HD.renderActiveTab() });
  };

  // Settings → Certificates: an extra CA, and client certificates for mutual TLS.
  function renderCertificates(panel, s, rerender) {
    const base = (f) => (f ? String(f).split(/[\\/]/).pop() : '');
    const choose = async (filters) => { const [f] = await window.api.openFile({ filters }); return f || null; };
    const PEM = [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'key'] }, { name: 'All files', extensions: ['*'] }];
    const PFX = [{ name: 'PKCS #12', extensions: ['pfx', 'p12'] }, { name: 'All files', extensions: ['*'] }];

    const ca = (s.caCertificate = s.caCertificate || { enabled: false, path: '' });
    panel.append(
      h('div.setting-row',
        h('div', h('div.setting-label', 'Trust certificates installed on this computer'), h('div.setting-help', 'Uses the certificate authorities in your system\'s store (macOS Keychain, Windows certificate store), as browsers do, so company certificates work without extra setup.')),
        h('label.switch', h('input', { type: 'checkbox', checked: s.useSystemCertificates !== false, onchange: (e) => { s.useSystemCertificates = e.target.checked; HD.save(); } }), h('span.slider'))),
      h('div.setting-row',
        h('div', h('div.setting-label', 'CA certificate'), h('div.setting-help', ca.path ? h('span.mono', ca.path) : 'Trust an extra certificate authority, such as your company\'s, in addition to the built-in ones. PEM file.')),
        h('div.cert-actions',
          HD.button(ca.path ? 'Change…' : 'Choose…', async () => { const f = await choose(PEM); if (f) { ca.path = f; ca.enabled = true; HD.save(); rerender(); } }, { small: true }),
          ca.path ? h('label.switch', { title: 'Use this CA certificate' }, h('input', { type: 'checkbox', checked: ca.enabled !== false, onchange: (e) => { ca.enabled = e.target.checked; HD.save(); } }), h('span.slider')) : null)));

    const list = (s.certificates = s.certificates || []);
    panel.append(h('div.setting-row.cert-head',
      h('div', h('div.setting-label', 'Client certificates'), h('div.setting-help', 'Sent to the hosts you choose, for APIs that use mutual TLS. The first matching certificate is used; leave the port empty to match any port.'))));
    panel.append(list.length ? h('div.cert-list', list.map((c, i) => h('div.cert-item',
      h('div.cert-main',
        h('div.cert-host', c.host + (c.port ? `:${c.port}` : '')),
        h('div.cert-files.muted.small', [c.pfx ? `PFX: ${base(c.pfx)}` : null, c.crt ? `CRT: ${base(c.crt)}` : null, c.key ? `KEY: ${base(c.key)}` : null, c.passphrase ? 'passphrase set' : null].filter(Boolean).join(' · '))),
      h('label.switch', { title: 'Use this certificate' }, h('input', { type: 'checkbox', checked: c.enabled !== false, onchange: (e) => { c.enabled = e.target.checked; HD.save(); } }), h('span.slider')),
      HD.button('', () => { list.splice(i, 1); HD.save(); rerender(); }, { icon: 'trash', ghost: true, small: true, title: 'Remove certificate' }))))
      : h('div.muted.small.cert-empty', 'No client certificates yet.'));

    // The add form; nothing is saved until "Add certificate" is clicked.
    const draft = { host: '', port: '', crt: '', key: '', pfx: '', passphrase: '' };
    const fileField = (key, label, filters) => {
      const name = h('span.cert-file.muted.small', 'None');
      const btn = HD.button('Choose…', async () => { const f = await choose(filters); if (f) { draft[key] = f; name.textContent = base(f); name.title = f; } }, { small: true });
      return h('div.field', h('span', label), h('div.cert-file-row', btn, name));
    };
    const input = (key, label, opts = {}) => h('label.field', h('span', label), (opts.type === 'password' ? HD.revealable : (x) => x)(h('input.input', { type: opts.type || 'text', placeholder: opts.placeholder || '', spellcheck: 'false', oninput: (e) => { draft[key] = e.target.value; } })));
    const form = h('div.cert-form',
      h('div.field-row', input('host', 'Host', { placeholder: 'api.example.com or *.example.com' }), input('port', 'Port (optional)', { placeholder: '443' })),
      h('div.field-row', fileField('crt', 'CRT file', PEM), fileField('key', 'KEY file', PEM)),
      h('div.field-row', fileField('pfx', 'or PFX file', PFX), input('passphrase', 'Passphrase (optional)', { type: 'password' })),
      HD.button('Add certificate', () => {
        const host = draft.host.trim();
        if (!host) { HD.toast('Enter the host the certificate is for', 'warn'); return; }
        if (!draft.pfx && !(draft.crt && draft.key)) { HD.toast('Choose a CRT and KEY file, or a PFX file', 'warn'); return; }
        list.push({ host, port: draft.port.trim(), crt: draft.crt, key: draft.key, pfx: draft.pfx, passphrase: draft.passphrase, enabled: true });
        HD.save();
        rerender();
      }, { primary: true, small: true }));
    panel.append(h('details.cert-add', list.length ? {} : { open: true }, h('summary', 'Add a client certificate'), form));
  }

  // ---- Cookies ------------------------------------------------------------------------------

  HD.showCookies = async () => {
    let jar = await window.api.cookies.list();
    let selectedDomain = null;
    const body = h('div.cookies');
    const render = () => {
      HD.clear(body);
      const domains = [...new Set(jar.map((c) => c.domain))].sort();
      if (!selectedDomain || !domains.includes(selectedDomain)) selectedDomain = domains[0] || null;
      const list = h('div.cookie-domains',
        domains.length ? domains.map((d) => h('div.cookie-domain', { class: d === selectedDomain ? 'selected' : '', onclick: () => { selectedDomain = d; render(); } },
          h('span', d), h('span.muted.small', String(jar.filter((c) => c.domain === d).length)),
          h('button.kv-delete', { type: 'button', title: 'Delete all cookies for this domain', onclick: async (e) => { e.stopPropagation(); jar = await window.api.cookies.clearDomain(d); render(); } }, HD.icon('trash'))))
          : h('div.muted.small.panel-pad', 'The cookie jar is empty.'));
      const cookies = jar.filter((c) => c.domain === selectedDomain);
      const detail = h('div.cookie-list',
        cookies.map((c) => h('div.cookie-item',
          h('div.cookie-head', h('b.mono', c.name), h('span.spacer'),
            HD.button('', () => edit(c), { icon: 'edit', ghost: true, small: true, title: 'Edit' }),
            HD.button('', async () => { jar = await window.api.cookies.remove(c); render(); }, { icon: 'trash', ghost: true, small: true, title: 'Delete' })),
          h('div.mono.small.break', `${c.name}=${c.value}; Path=${c.path}${c.expires ? `; Expires=${new Date(c.expires).toUTCString()}` : ''}${c.secure ? '; Secure' : ''}${c.httpOnly ? '; HttpOnly' : ''}`))),
        h('div.button-row', HD.button('Add cookie', () => edit({ domain: selectedDomain || '', path: '/', name: '', value: '' }, true), { small: true, icon: 'plus' })));
      body.append(list, detail);
    };
    const edit = (cookie, isNew) => {
      const f = { ...cookie };
      const inp = (k, label) => h('label.field', h('span', label), h('input.input', { value: f[k] == null ? '' : f[k], oninput: (e) => { f[k] = e.target.value; } }));
      HD.modal({
        title: isNew ? 'Add cookie' : 'Edit cookie', width: 440,
        body: h('div', inp('domain', 'Domain'), inp('path', 'Path'), inp('name', 'Name'), inp('value', 'Value'),
          h('label.check', h('input', { type: 'checkbox', checked: !!f.secure, onchange: (e) => { f.secure = e.target.checked; } }), 'Secure'),
          h('label.check', h('input', { type: 'checkbox', checked: !!f.httpOnly, onchange: (e) => { f.httpOnly = e.target.checked; } }), 'HttpOnly')),
        buttons: [{ label: 'Cancel' }, {
          label: 'Save', primary: true,
          onClick: async () => {
            if (!f.domain || !f.name) { HD.toast('Domain and name are required', 'warn'); return false; }
            if (!isNew && (cookie.name !== f.name || cookie.domain !== f.domain || cookie.path !== f.path)) await window.api.cookies.remove(cookie);
            jar = await window.api.cookies.upsert({ ...f, domain: f.domain.replace(/^\./, '').toLowerCase() });
            selectedDomain = f.domain;
            render();
            return true;
          },
        }],
      });
    };
    render();
    HD.modal({
      title: 'Cookies', width: 780, body,
      buttons: [{ label: 'Clear all', danger: true, onClick: async () => { if (await HD.confirm('Clear cookies', 'Delete every cookie in the jar?', { danger: true, okLabel: 'Clear' })) { jar = await window.api.cookies.clear(); render(); } return false; } }, { label: 'Close', primary: true }],
    });
  };

  // ---- Environment quick look ----------------------------------------------------------------

  HD.showQuickLook = (anchor) => {
    document.querySelectorAll('.quicklook').forEach((q) => q.remove());
    const env = HD.activeEnvironment();
    const tab = HD.currentTab();
    const found = tab && tab.refId ? HD.find(tab.refId) : null;
    const section = (title, list, onEdit) => h('div.ql-section',
      h('div.ql-head', h('b', title), onEdit ? HD.button('Edit', onEdit, { small: true, ghost: true }) : null),
      list && list.filter((v) => v.key).length
        ? h('table.data-table.compact', h('tbody', list.filter((v) => v.key).map((v) => h('tr', { class: v.enabled === false ? 'disabled' : '' }, h('td.mono', v.key), h('td.mono.break', v.secret ? '••••••' : String(v.value))))))
        : h('div.muted.small', 'No variables'));
    const pop = h('div.quicklook',
      section(env ? `Environment: ${env.name}` : 'No environment selected', env ? env.values : null, env ? () => { pop.remove(); HD.openEnvironment(env.id); } : null),
      found ? section(`Collection: ${found.collection.name}`, found.collection.variables, () => { pop.remove(); HD.openContainer(found.collection.id, 'variables'); }) : null,
      section('Globals', S.ws.globals, () => { pop.remove(); HD.openGlobals(); }));
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', dismiss, true); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  };
})();
