'use strict';

/* Response viewer: body (pretty/raw/preview/visualize), headers, cookies, tests and timeline. */
(() => {
  const { h } = HD;

  const detectLang = (contentType, text) => {
    const ct = (contentType || '').toLowerCase();
    if (/json/.test(ct)) return 'json';
    if (/html/.test(ct)) return 'html';
    if (/xml/.test(ct)) return 'xml';
    if (/javascript/.test(ct)) return 'javascript';
    const t = (text || '').trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return 'json';
    if (/^<!doctype html|^<html/i.test(t)) return 'html';
    if (t.startsWith('<')) return 'xml';
    return 'text';
  };
  HD.detectLang = detectLang;

  const VOID_TAGS = /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b/i;
  HD.formatXml = (xml) => {
    const tokens = (xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []).map((t) => t.trim()).filter(Boolean);
    const isClose = (t) => /^<\//.test(t);
    const isOpen = (t) => /^<[^!?/]/.test(t) && !/\/>$/.test(t) && !VOID_TAGS.test(t);
    const isText = (t) => !t.startsWith('<');
    const out = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (isClose(t)) {
        depth = Math.max(0, depth - 1);
        out.push('  '.repeat(depth) + t);
      } else if (isOpen(t)) {
        // Keep <a>text</a> on one line.
        if (tokens[i + 1] && isText(tokens[i + 1]) && tokens[i + 2] && isClose(tokens[i + 2])) {
          out.push('  '.repeat(depth) + t + tokens[i + 1] + tokens[i + 2]);
          i += 2;
        } else if (tokens[i + 1] && isClose(tokens[i + 1])) {
          out.push('  '.repeat(depth) + t + tokens[i + 1]);
          i += 1;
        } else {
          out.push('  '.repeat(depth) + t);
          depth++;
        }
      } else out.push('  '.repeat(depth) + t);
    }
    return out.join('\n');
  };

  // Bodies larger than the "large response" setting show only their start until the user asks for
  // all of it: loading megabytes into the editor freezes the window.
  const DEFAULT_LARGE_BYTES = 2 * 1024 * 1024;
  const PREVIEW_CHARS = 512 * 1024;
  const showAll = new WeakSet(); // responses the user chose to show in full
  const prettyCache = new WeakMap(); // response -> { lang, text }, so switching tabs doesn't re-format

  const pretty = (text, lang) => {
    if (lang === 'json') {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    }
    if (lang === 'xml' || lang === 'html') {
      try { return text.length < 2e6 ? HD.formatXml(text) : text; } catch { return text; }
    }
    return text;
  };
  // The parsed body for the table view, or undefined when it isn't JSON. Cached like the pretty text.
  const parsedCache = new WeakMap();
  const parsedJson = (res) => {
    if (!parsedCache.has(res)) {
      let v;
      try { v = JSON.parse(res.bodyText); } catch { v = undefined; }
      parsedCache.set(res, v);
    }
    return parsedCache.get(res);
  };
  const prettyFor = (res, lang) => {
    const hit = prettyCache.get(res);
    if (hit && hit.lang === lang) return hit.text;
    const text = pretty(res.bodyText, lang);
    prettyCache.set(res, { lang, text });
    return text;
  };

  const parseSetCookie = (v) => {
    const [nv, ...attrs] = String(v).split(';');
    const i = nv.indexOf('=');
    const c = { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim(), domain: '', path: '', expires: '', httpOnly: false, secure: false };
    for (const a of attrs) {
      const j = a.indexOf('=');
      const k = (j === -1 ? a : a.slice(0, j)).trim().toLowerCase();
      const val = j === -1 ? '' : a.slice(j + 1).trim();
      if (k === 'domain') c.domain = val;
      else if (k === 'path') c.path = val;
      else if (k === 'expires') c.expires = val;
      else if (k === 'max-age') c.expires = `in ${val}s`;
      else if (k === 'httponly') c.httpOnly = true;
      else if (k === 'secure') c.secure = true;
    }
    return c;
  };

  // Which instance of a discovered service answered (see Service discovery → Load balancing).
  const instanceStat = (routing) => h('span.res-stat.res-instance.has-popover',
    h('span.muted', 'Instance '), h('b', HD.instanceLabel(routing[0])), routing.length > 1 ? h('span.muted', ` +${routing.length - 1}`) : null,
    h('div.popover', h('div.popover-title', 'Instances'),
      routing.map((r) => h('div.kvline', h('span', `{{${r.variable}}}`), h('span', [r.instance, r.servedBy ? ` (${r.servedBy})` : ''].join(''))))));

  const statusLine = (res, actions, routing, payload) => {
    const t = res.timings || {};
    const timingRows = [
      ['DNS lookup', t.dns], ['TCP connect', t.connect != null ? t.connect - (t.dns || 0) : null],
      ['TLS handshake', t.tls != null ? t.tls - (t.connect || 0) : null],
      ['Time to first byte', t.firstByte != null ? t.firstByte - (t.tls || t.connect || 0) : null],
      ['Download', t.download], ['Total', t.total],
    ].filter(([, v]) => v != null);
    const timeTip = h('div.popover', h('div.popover-title', 'Response time'), timingRows.map(([l, v]) => h('div.kvline', h('span', l), h('span', HD.formatMs(v)))),
      t.reused ? h('div.kvline', h('span', 'Connection'), h('span', 'reused')) : null);
    const sizeTip = h('div.popover', h('div.popover-title', 'Response size'),
      h('div.kvline', h('span', 'Headers'), h('span', HD.formatBytes(res.headersSize))),
      h('div.kvline', h('span', 'Body'), h('span', HD.formatBytes(res.bodySize))),
      h('div.kvline', h('span', 'Transferred'), h('span', HD.formatBytes(res.size))));
    return h('div.res-meta',
      h(`span.res-status.${HD.statusClass(res.status)}`, `${res.status} ${res.statusText || ''}`),
      h('span.res-stat.has-popover', h('span.muted', 'Time '), h('b', HD.formatMs(res.time)), timeTip),
      h('span.res-stat.has-popover', h('span.muted', 'Size '), h('b', HD.formatBytes(res.size)), sizeTip),
      res.redirects && res.redirects.length ? h('span.res-stat.muted', `${res.redirects.length} redirect${res.redirects.length > 1 ? 's' : ''}`) : null,
      routing && routing.length ? instanceStat(routing) : null,
      payload ? h('span.res-stat.res-payload', { title: 'The payload this call sent (Payloads tab)' }, h('span.muted', 'Payload '), h('b', payload.name), h('span.muted', ` ${payload.index + 1}/${payload.count}`)) : null,
      h('span.spacer'),
      actions);
  };

  /**
   * A list of Server-Sent Events: time since the request was sent, event name, data and id.
   * Click an event to see its data pretty-printed. Returns { append(events) } for live updates.
   */
  HD.renderEventList = (parent, events) => {
    const list = h('div.sse-list');
    const prettyData = (d) => { try { return JSON.stringify(JSON.parse(d), null, 2); } catch { return d; } };
    const row = (e, i) => {
      const r = h('div.sse-row',
        h('span.sse-n.muted', String(i + 1)),
        h('span.sse-time.muted', e.t != null ? `+${HD.formatMs(e.t)}` : ''),
        h('span.sse-event', e.event),
        h('span.sse-data', e.data.length > 300 ? `${e.data.slice(0, 300)}…` : e.data),
        h('span.sse-id.muted', e.id ? `id ${e.id}` : ''));
      r.onclick = () => {
        const next = r.nextSibling;
        if (next && next.classList && next.classList.contains('sse-detail')) { next.remove(); return; }
        r.after(h('div.sse-detail', h('div.sse-detail-actions', HD.button('Copy', (ev) => { ev.stopPropagation(); HD.copy(e.data); }, { small: true, ghost: true })), h('pre', prettyData(e.data))));
      };
      return r;
    };
    let count = 0;
    const append = (more) => {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      const frag = document.createDocumentFragment();
      for (const e of more) frag.appendChild(row(e, count++));
      list.appendChild(frag);
      if (atBottom) list.scrollTop = list.scrollHeight;
    };
    append(events);
    parent.appendChild(list);
    return { append };
  };

  /**
   * Renders the response area.
   * result: the object returned by the main process (response, error, tests, sentRequest, visualizer)
   * ui: persisted per-tab view state ({ resTab, bodyView, wrap })
   */
  HD.renderResponse = (root, result, ui, opts = {}) => {
    HD.clear(root);
    const res = result.response;
    const tests = result.tests || [];
    const passed = tests.filter((t) => t.passed && !t.skipped).length;
    const failed = tests.filter((t) => !t.passed).length;
    const headerCount = res ? res.headers.length : 0;
    const setCookies = res ? res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v)) : [];

    const tabs = [
      { id: 'body', label: 'Body' },
      { id: 'cookies', label: 'Cookies', badge: setCookies.length || null },
      { id: 'headers', label: 'Headers', badge: headerCount || null },
      { id: 'tests', label: 'Test Results', badge: tests.length ? `${passed}/${tests.length}` : null, dot: failed > 0 },
      { id: 'timeline', label: 'Timeline' },
    ];
    const cmp = result.compare && result.compare.comparison;
    if (cmp) {
      const odd = cmp.instances.filter((i) => i.odd).length;
      tabs.unshift({ id: 'compare', label: 'Compare', badge: odd ? `${odd}/${cmp.instances.length}` : String(cmp.instances.length), dot: odd > 0 });
    }
    if (result.health) tabs.push({ id: 'health', label: 'Health', dot: !result.health.ok });
    let active = ui.resTab || 'body';
    if (active === 'compare' && !cmp) active = 'body';
    if (active === 'health' && !result.health) active = 'body';
    if (!res && active !== 'tests' && active !== 'timeline' && active !== 'compare' && active !== 'health') active = 'body';

    const actions = h('div.res-actions',
      res ? HD.button('', (e) => HD.menu(e, [
        { label: 'Save response to file', onClick: () => window.api.saveResponse({ name: suggestName(res), bodyText: res.bodyText, bodyBase64: res.bodyBase64 }) },
        opts.onSaveExample ? { label: 'Save as example', onClick: opts.onSaveExample } : null,
        { label: 'Copy body', onClick: () => HD.copy(res.bodyText || '') },
        { separator: true },
        { label: 'Clear response', onClick: opts.onClear },
      ]), { icon: 'dots', ghost: true, small: true, title: 'More actions' }) : null);

    const content = h('div.res-content');
    const strip = HD.tabStrip(tabs.filter((t) => res || t.id === 'tests' || t.id === 'timeline' || t.id === 'body' || t.id === 'compare' || t.id === 'health'), active, (id) => { ui.resTab = id; HD.save(); HD.renderResponse(root, result, ui, opts); });
    root.appendChild(h('div.res-header', strip, res ? statusLine(res, actions, result.routing, result.payload) : null));
    if (result.fromVersion) {
      root.appendChild(h('div.dep-banner.version-banner', h('div.dep-run', HD.icon('history'),
        h('span', `The response version “${result.fromVersion.name}” got when you sent it ${HD.versionAgo ? HD.versionAgo(result.fromVersion.time) : ''}. Send to get a fresh one.`))));
    }
    const banner = HD.dependencyBanner && HD.dependencyBanner(result.dependencyRuns);
    if (banner) root.appendChild(banner);
    if (result.savedVariables && result.savedVariables.length) {
      root.appendChild(h('div.dep-banner', h('div.dep-run', HD.icon('check'),
        h('span', `Saved ${result.savedVariables.map((k) => `{{${k}}}`).join(', ')} for the requests that depend on this one`))));
    }
    root.appendChild(content);

    if (active === 'compare') {
      renderCompare(content, result, opts, () => HD.renderResponse(root, result, ui, opts), (i) => {
        // Shows one instance's answer in the other tabs.
        const r = result.compare.results[i];
        for (const k of ['response', 'tests', 'sentRequest', 'routing', 'error', 'payload', 'dependencyRuns', 'health', 'network']) result[k] = r[k];
        result.compare.shown = i;
        ui.resTab = 'body';
        HD.save();
        HD.renderResponse(root, result, ui, opts);
      });
    } else if (active === 'body') {
      if (result.error) {
        content.appendChild(h('div.res-error',
          h('div.res-error-title', 'Could not send request'),
          h('pre.res-error-msg', result.error),
          h('div.muted', 'Check the URL, your network, proxy and SSL settings. Script output is in the Console.')));
      } else if (res) renderBody(content, res, result, ui, () => HD.renderResponse(root, result, ui, opts));
    } else if (active === 'headers') {
      content.appendChild(h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', h('th', 'Key'), h('th', 'Value'))),
        h('tbody', res.headers.map(([k, v]) => h('tr', h('td.mono', k), h('td.mono.break', v)))))));
    } else if (active === 'cookies') {
      content.appendChild(setCookies.length ? h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', ['Name', 'Value', 'Domain', 'Path', 'Expires', 'HttpOnly', 'Secure'].map((x) => h('th', x)))),
        h('tbody', setCookies.map((c) => h('tr', h('td.mono', c.name), h('td.mono.break', c.value), h('td', c.domain), h('td', c.path), h('td', c.expires), h('td', c.httpOnly ? 'true' : 'false'), h('td', c.secure ? 'true' : 'false'))))))
        : h('div.empty-state.small', 'No cookies were set by this response.'));
    } else if (active === 'tests') {
      renderTests(content, result, ui, () => HD.renderResponse(root, result, ui, opts));
    } else if (active === 'timeline') {
      renderTimeline(content, result);
    } else if (active === 'health') {
      HD.renderHealth(content, result.health);
    }
  };

  function suggestName(res) {
    const ct = (res.contentType || '').toLowerCase();
    const ext = /json/.test(ct) ? 'json' : /html/.test(ct) ? 'html' : /xml/.test(ct) ? 'xml' : /png/.test(ct) ? 'png' : /jpe?g/.test(ct) ? 'jpg' : /pdf/.test(ct) ? 'pdf' : 'txt';
    return `response.${ext}`;
  }

  function renderBody(content, res, result, ui, rerender) {
    const isImage = /^image\//i.test(res.contentType || '');
    const lang = detectLang(res.contentType, res.bodyText);
    const views = [{ id: 'pretty', label: 'Pretty' }, { id: 'raw', label: 'Raw' }, { id: 'preview', label: 'Preview' }];
    const events = res.events && res.events.length ? res.events : null;
    if (events) views.unshift({ id: 'events', label: `Events (${events.length})` });
    const json = lang === 'json' && res.bodyText ? parsedJson(res) : undefined;
    if (json !== undefined) views.splice(1, 0, { id: 'table', label: 'Table' });
    if (result.visualizer) views.push({ id: 'visualize', label: 'Visualize' });
    let view = ui.bodyView || (events ? 'events' : 'pretty');
    if (view === 'events' && !events) view = 'pretty';
    if (isImage && view !== 'raw') view = 'preview';
    if (view === 'visualize' && !result.visualizer) view = 'pretty';
    if (view === 'table' && json === undefined) view = 'pretty';
    const langOverride = ui.bodyLang && ui.bodyLang !== 'auto' ? ui.bodyLang : lang;

    const toolbar = h('div.body-toolbar',
      HD.tabStrip(views, view, (id) => { ui.bodyView = id; HD.save(); rerender(); }, 'segmented'),
      view === 'pretty' ? HD.select([['auto', `Auto (${lang.toUpperCase()})`], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['javascript', 'JavaScript'], ['text', 'Text']], ui.bodyLang || 'auto', (v) => { ui.bodyLang = v; HD.save(); rerender(); }, 'select-small') : null,
      h('span.spacer'),
      view !== 'preview' && view !== 'visualize' ? HD.button('', () => { ui.wrap = !ui.wrap; HD.save(); rerender(); }, { icon: 'wrap', ghost: true, small: true, title: 'Toggle line wrap', class: ui.wrap ? 'active' : '' }) : null,
      view !== 'preview' && view !== 'visualize' ? HD.button('', () => { const cm = content.querySelector('.CodeMirror'); if (cm) { cm.CodeMirror.focus(); cm.CodeMirror.execCommand('findPersistent'); } }, { icon: 'search', ghost: true, small: true, title: 'Search (Ctrl+F)' }) : null,
      HD.button('', () => HD.copy(res.bodyText || ''), { icon: 'copy', ghost: true, small: true, title: 'Copy body' }));
    content.appendChild(toolbar);
    const limit = HD.S.ws.settings.largeResponseBytes == null ? DEFAULT_LARGE_BYTES : HD.S.ws.settings.largeResponseBytes;
    const large = res.bodyText != null && limit > 0 && res.bodyText.length > limit;
    // The table view renders a page of rows at a time, so it stays fast for large responses.
    const partial = large && !showAll.has(res) && !(isImage && view === 'preview') && view !== 'visualize' && view !== 'table';
    if (partial) {
      content.appendChild(h('div.large-banner',
        h('span', `Large response (${HD.formatBytes(res.bodySize)}). Showing the first ${HD.formatBytes(PREVIEW_CHARS)} to keep HttpDash responsive.`),
        h('span.spacer'),
        HD.button('Show all', () => { showAll.add(res); rerender(); }, { small: true }),
        HD.button('Save to file', () => window.api.saveResponse({ name: suggestName(res), bodyText: res.bodyText, bodyBase64: res.bodyBase64 }), { small: true, ghost: true })));
    }
    const area = h('div.body-area');
    content.appendChild(area);

    if (view === 'preview' && !partial) {
      if (isImage && res.bodyBase64) {
        area.appendChild(h('div.image-preview', h('img', { src: `data:${res.contentType.split(';')[0]};base64,${res.bodyBase64}`, alt: 'Response image' })));
      } else if (res.bodyText != null) {
        // Sandboxed (no scripts) preview of the HTML.
        const frame = h('iframe.preview-frame', { sandbox: '', referrerpolicy: 'no-referrer' });
        frame.srcdoc = lang === 'html' ? res.bodyText : `<pre style="white-space:pre-wrap;font:12px monospace">${res.bodyText.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
        area.appendChild(frame);
      } else area.appendChild(h('div.empty-state.small', `Binary response (${res.contentType || 'unknown type'}, ${HD.formatBytes(res.bodySize)}). Use "Save response to file".`));
      return;
    }
    if (view === 'events') {
      if (res.cancelled) area.appendChild(h('div.large-banner', h('span', `Stopped after ${events.length} event${events.length === 1 ? '' : 's'}. The response below is what arrived before you stopped it.`)));
      area.classList.add('sse-area');
      HD.renderEventList(area, events);
      return;
    }
    if (view === 'table') {
      area.classList.add('jt-area');
      HD.renderJsonTable(area, json);
      return;
    }
    if (view === 'visualize') {
      let html;
      try { html = HD.renderTemplate(result.visualizer.template, result.visualizer.data); } catch (e) { html = `<pre>Visualizer error: ${String(e.message)}</pre>`; }
      const frame = h('iframe.preview-frame', { sandbox: '', referrerpolicy: 'no-referrer' });
      frame.srcdoc = `<style>body{font-family:system-ui,sans-serif;font-size:13px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>${html}`;
      area.appendChild(frame);
      return;
    }
    if (res.bodyText == null) {
      area.appendChild(h('div.empty-state.small', `Binary response (${res.contentType || 'unknown type'}, ${HD.formatBytes(res.bodySize)}).`));
      return;
    }
    const full = view === 'pretty' ? prettyFor(res, langOverride) : res.bodyText;
    const text = partial ? `${full.slice(0, PREVIEW_CHARS)}\n…` : full;
    // Highlighting and code folding are what make huge documents slow, so they're off for large ones.
    HD.editor(area, { value: text, mode: view === 'pretty' && !large ? langOverride : 'text', readOnly: true, wrap: !!ui.wrap, plain: large });
  }

  function renderTests(content, result, ui, rerender) {
    const tests = result.tests || [];
    if (!tests.length) {
      content.appendChild(h('div.empty-state.small',
        result.testError ? h('div.text-error', `Test script error: ${result.testError}`) : null,
        h('div', 'No tests were run for this request.'),
        h('div.muted', 'Write tests in the "Tests" tab, e.g. pm.test("Status is 200", () => pm.response.to.have.status(200));')));
      return;
    }
    const filter = ui.testFilter || 'all';
    const counts = {
      all: tests.length,
      passed: tests.filter((t) => t.passed && !t.skipped).length,
      skipped: tests.filter((t) => t.skipped).length,
      failed: tests.filter((t) => !t.passed).length,
    };
    content.appendChild(h('div.body-toolbar', HD.tabStrip(['all', 'passed', 'skipped', 'failed'].map((id) => ({ id, label: `${id[0].toUpperCase()}${id.slice(1)} (${counts[id]})` })), filter, (id) => { ui.testFilter = id; rerender(); }, 'segmented')));
    if (result.testError) content.appendChild(h('div.test-script-error', `Test script error: ${result.testError}`));
    if (result.preRequestError) content.appendChild(h('div.test-script-error', `Pre-request script error: ${result.preRequestError}`));
    const shown = tests.filter((t) => filter === 'all' || (filter === 'passed' && t.passed && !t.skipped) || (filter === 'skipped' && t.skipped) || (filter === 'failed' && !t.passed));
    content.appendChild(h('div.test-list', shown.map((t) => h('div.test-item',
      h(`span.test-badge.${t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}`, t.skipped ? 'SKIPPED' : t.passed ? 'PASS' : 'FAIL'),
      h('div', h('div.test-name', t.name), t.error ? h('div.test-error', t.error) : null)))));
  }

  // ---- Compare instances -------------------------------------------------------------------

  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
  const keyLabel = (key) => (key === 'status' ? 'Status' : key === 'error' ? 'Error' : key === 'body' ? 'Body (text)'
    : key.startsWith('header:') ? `Header ${key.slice(7)}` : key.slice(5));
  // What an Ignore button ignores: a header by name, a body path with any array index ([*]).
  const ignoreFor = (key) => (key.startsWith('header:') ? { header: key.slice(7) } : key.startsWith('body:') ? { path: key.slice(5).replace(/\[\d+\]/g, '[*]') } : null);
  const clip = (v) => (v.length > 140 ? `${v.slice(0, 140)}…` : v);

  function renderCompare(content, result, opts, rerender, showInstance) {
    const c = result.compare;
    const cmp = c.comparison;
    const n = cmp.instances.length;
    const name = (i) => i.instanceId || hostOf(i.instance);
    const odd = cmp.differences.filter((d) => d.kind === 'odd');
    const split = cmp.differences.filter((d) => d.kind === 'split');
    const varies = cmp.differences.filter((d) => d.kind === 'varies');
    const oddOnes = cmp.instances.filter((i) => i.odd);
    const wrap = h('div.panel-pad.compare');

    let verdict;
    if (!odd.length && !split.length) {
      verdict = h('div.compare-verdict.same', HD.icon('check'), h('span', `All ${n} ${c.dns ? 'addresses' : 'instances'} of ${c.service} answered the same`,
        varies.length ? h('span.muted', `, apart from ${varies.length} value${varies.length === 1 ? '' : 's'} that differ on every instance`) : null));
    } else if (oddOnes.length) {
      verdict = h('div.compare-verdict.differs', HD.icon('x'), h('span', h('b', oddOnes.map(name).join(', ')),
        ` answered differently from the other ${n - oddOnes.length}`, h('span.muted', ` · ${odd.length} difference${odd.length === 1 ? '' : 's'}`)));
    } else {
      verdict = h('div.compare-verdict.differs', HD.icon('x'), h('span', 'The instances don\'t agree, and no answer stands out', h('span.muted', ` · ${split.length} difference${split.length === 1 ? '' : 's'}`)));
    }
    wrap.appendChild(h('div.compare-head', verdict, h('span.muted.small', c.dns ? `${c.service} · ${n} addresses from DNS, sent to at once` : `{{${c.variable}}} · sent to ${n} instances at once`)));

    // The instances, with a slow one flagged against the median.
    const times = cmp.instances.map((i) => i.time).filter((t) => t != null).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    // The address each instance answered from, and its segment when they aren't all on one.
    const nets = cmp.instances.map((_, idx) => { const r = (c.results || [])[idx]; return r && r.network && r.network.connected; });
    const segs = new Set(nets.filter(Boolean).map((x) => x.segment));
    wrap.appendChild(h('div.table-wrap.no-pad', h('table.data-table.compare-instances',
      h('thead', h('tr', h('th', 'Instance'), nets.some(Boolean) ? h('th', 'Address') : null, h('th', 'Status'), h('th.num', 'Time'), h('th', 'Tests'), h('th', 'Answer'), h('th', ''))),
      h('tbody', cmp.instances.map((i, idx) => h('tr', { class: c.shown === idx ? 'shown' : '' },
        h('td', h('div', name(i)), hostOf(i.instance) !== name(i) ? h('div.muted.small.mono', hostOf(i.instance)) : null),
        nets.some(Boolean) ? h('td', nets[idx] ? [h('div.mono.small', nets[idx].address), segs.size > 1 ? h('div.muted.small.mono', nets[idx].segment) : null] : h('span.muted', '—')) : null,
        h('td', i.error ? h('span.text-error.small', i.error) : h(`span.${HD.statusClass(i.status)}`, String(i.status))),
        h('td.num', i.time == null ? '—' : HD.formatMs(i.time),
          median != null && i.time >= 2 * median && i.time - median >= 50 ? h('span.pill.changed', { title: `median ${HD.formatMs(median)}` }, 'slow') : null),
        h('td', i.tests.passed + i.tests.failed ? h('span', { class: i.tests.failed ? 'text-error' : 'text-ok' }, `${i.tests.passed}/${i.tests.passed + i.tests.failed}`) : h('span.muted', '—')),
        h('td', i.odd ? h('span.pill.removed', `differs in ${i.odd}`) : split.length ? h('span.muted', '—') : h('span.pill.added', 'same')),
        h('td', c.shown === idx ? h('span.muted.small', 'shown') : HD.button('Show', () => showInstance(idx), { small: true, ghost: true, title: 'Show this instance\'s answer in Body, Headers and Timeline' }))))))));

    const ignoreBtn = (key) => {
      const ig = ignoreFor(key);
      return ig && opts.compareIgnore ? HD.button('Ignore', () => opts.compareIgnore(ig), { small: true, ghost: true, title: ig.header ? `Ignore the ${ig.header} header when comparing this request` : `Ignore ${ig.path} when comparing this request` }) : null;
    };
    const valueCell = (v) => h('code.compare-value', { title: v }, clip(v));
    if (odd.length || split.length) {
      wrap.appendChild(h('div.section-title', 'Differences'));
      wrap.appendChild(h('div.table-wrap.no-pad', h('table.data-table.compare-diffs',
        h('thead', h('tr', h('th', 'Field'), h('th', 'Most instances'), h('th', 'Differs on'), h('th', ''))),
        h('tbody', [...odd, ...split].map((d) => h('tr',
          h('td.mono', keyLabel(d.key)),
          h('td', d.kind === 'odd' ? valueCell(d.majority) : h('span.muted', 'no majority')),
          h('td', (d.kind === 'odd' ? d.values.filter((v) => d.odd.includes(v.instance)) : d.values).map((v) => h('div.compare-odd', h('span.compare-who', v.instanceId || hostOf(v.instance)), valueCell(v.value)))),
          h('td', ignoreBtn(d.key))))))));
    }
    if (varies.length) {
      wrap.appendChild(h('details.compare-varies', { open: !odd.length && !split.length && varies.length <= 5 },
        h('summary', `Different on every instance (${varies.length})`, h('span.muted.small', ' · usually ids, timestamps or the instance\'s own name')),
        h('div.table-wrap.no-pad', h('table.data-table.compare-diffs',
          h('tbody', varies.map((d) => h('tr',
            h('td.mono', keyLabel(d.key)),
            h('td', d.values.map((v) => h('div.compare-odd', h('span.compare-who', v.instanceId || hostOf(v.instance)), valueCell(v.value)))),
            h('td', ignoreBtn(d.key)))))))));
    }
    const ig = opts.compareIgnored || {};
    const chips = [...(ig.ignoreHeaders || []).map((x) => ({ header: x })), ...(ig.ignorePaths || []).map((x) => ({ path: x }))];
    if (chips.length) {
      wrap.appendChild(h('div.compare-ignored', h('span.muted.small', 'Ignored for this request:'),
        chips.map((x) => h('span.chip', x.header ? `header ${x.header}` : x.path,
          opts.compareIgnore ? h('button.chip-x', { type: 'button', title: 'Compare it again', onclick: () => opts.compareIgnore({ ...x, remove: true }) }, '×') : null))));
    }
    content.appendChild(wrap);
  }

  function renderTimeline(content, result) {
    const s = result.sentRequest;
    const res = result.response;
    if (!s) {
      content.appendChild(h('div.empty-state.small', result.error || 'The request was not sent.'));
      return;
    }
    const section = (title, lines) => h('div.timeline-section', h('div.timeline-title', title), h('pre.timeline-body', lines));
    const parts = [];
    for (const d of result.dependencyRuns || []) {
      parts.push(section(`Auth dependency: ${d.name} (${HD.reasonText(d.reason)})`, [
        `${d.method || ''} ${d.url || ''}`.trim(),
        d.status ? `→ ${d.status} ${d.statusText} (${HD.formatMs(d.time)})` : null,
        Object.keys(d.stored || {}).length ? `Saved variables: ${Object.keys(d.stored).join(', ')}` : null,
        d.error ? `Error: ${d.error}` : null,
      ].filter(Boolean).join('\n')));
    }
    if (res && res.redirects && res.redirects.length) {
      parts.push(section('Redirects', res.redirects.map((r) => `${r.status}  ${r.from}\n   → ${r.to}`).join('\n')));
    }
    parts.push(section('Request', [`${s.method} ${s.url}`, ...s.headers.map(([k, v]) => `${k}: ${v}`)].join('\n')));
    if (s.bodyText) parts.push(section('Request body', s.bodyText.length > 50000 ? s.bodyText.slice(0, 50000) + '\n…' : s.bodyText));
    if (res) {
      parts.push(section('Response', [`HTTP/${res.httpVersion} ${res.status} ${res.statusText}`, ...res.headers.map(([k, v]) => `${k}: ${v}`)].join('\n')));
      const t = res.timings || {};
      parts.push(section('Timing', [
        t.dns != null ? `DNS lookup        ${HD.formatMs(t.dns)}` : null,
        t.connect != null ? `TCP connected     ${HD.formatMs(t.connect)}` : null,
        t.tls != null ? `TLS handshake     ${HD.formatMs(t.tls)}` : null,
        t.tunnel != null ? `Tunnel            ${HD.formatMs(t.tunnel)}${res.tunnel ? ` (${res.tunnel})` : ''}` : null,
        t.reused ? 'Connection        reused (no DNS, TCP or TLS setup)' : null,
        t.firstByte != null ? `First byte        ${HD.formatMs(t.firstByte)}` : null,
        `Total             ${HD.formatMs(t.total)}`,
        res.remoteAddress && !res.tunnel ? `Remote address    ${res.remoteAddress}` : null,
        res.clientCertificate ? `Client cert       ${res.clientCertificate}` : null,
      ].filter(Boolean).join('\n')));
    }
    if (result.network) parts.push(HD.networkSection(result.network));
    content.appendChild(h('div.timeline', parts));
  }
})();
