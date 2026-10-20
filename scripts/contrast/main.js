// Contrast audit: opens HttpDash, walks through its screens in the light and dark themes, and
// reports every piece of text whose contrast with its background is below WCAG AA (4.5:1, or
// 3:1 for large text). Run with `npm run audit:contrast`; it exits with 1 if anything fails.
const { app } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const root = path.join(__dirname, '..', '..');
process.env.HTTPDASH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'httpdash-contrast-'));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/sse')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: delta\nid: 1\ndata: {"text":"hi"}\n\nevent: stop\ndata: done\n\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc; Path=/; HttpOnly' });
  res.end(JSON.stringify({ data: [{ id: 1, name: 'Ann', ok: true, total: 12.5, tags: ['a'], note: null }, { id: 2, name: 'Bo', ok: false, total: 7, tags: [], note: 'x' }], page: 1 }));
});
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on('connection', (s) => { s.send('{"type":"welcome"}'); s.on('message', (d) => s.send(d.toString())); });
process.on('unhandledRejection', (e) => { console.log('The audit failed:', (e && e.stack) || e); app.exit(1); });
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => setTimeout(r, 800));
    await win.webContents.executeJavaScript(`${fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8')}\n;true`);
    const all = [];
    const run = async (name, setup) => {
      for (const theme of ['light', 'dark']) {
        const out = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          document.querySelectorAll('.modal-overlay, .ctx-menu').forEach((n) => n.remove());
          HD.S.ws.settings.theme = '${theme}'; HD.applyTheme(); await wait(50);
          ${setup}
          await wait(250);
          return window.__contrastAudit('${name} (${theme})');
        })()`).catch((e) => [{ state: name, error: e.message }]);
        all.push(...out);
      }
    };
    const P = port;
    await run('welcome', `HD.S.ws.tabs.slice().forEach((t) => HD.closeTab(t.id, true));`);
    await run('request + JSON response', `
      if (!window.__reqTab) { HD.S.ws.environments[0] && (HD.S.ws.activeEnvironmentId = HD.S.ws.environments[0].id);
        window.__reqTab = HD.openNewRequest({ method: 'POST', url: 'http://127.0.0.1:${P}/api/{{baseUrl}}/{{missingVar}}?q=1', headers: [{ key: 'X-Token', value: '{{token}}', enabled: true }], body: { mode: 'raw', rawLanguage: 'json', raw: '{"a": 1, "b": "text", "c": true, "d": null}' } }, 'Audit');
        HD.renderActiveTab(); await wait(150); document.querySelector('.send-btn').click(); await wait(500); }
      window.__reqTab.ui.resTab = 'body'; window.__reqTab.ui.bodyView = 'pretty'; window.__reqTab.ui.reqTab = 'body'; HD.renderActiveTab();`);
    await run('response table view', `window.__reqTab.ui.bodyView = 'table'; HD.renderActiveTab(); await wait(100); document.querySelector('.jt-toggle') && document.querySelector('.jt-toggle').click();`);
    await run('response headers + cookies', `window.__reqTab.ui.resTab = 'headers'; window.__reqTab.ui.reqTab = 'headers'; HD.renderActiveTab();`);
    await run('timeline', `window.__reqTab.ui.resTab = 'timeline'; window.__reqTab.ui.reqTab = 'auth'; HD.renderActiveTab();`);
    await run('test results', `
      const r = HD.S.responses.get(window.__reqTab.id);
      r.tests = [{ name: 'status is 200', passed: true }, { name: 'has token', passed: false, error: 'expected undefined to exist' }, { name: 'later', passed: true, skipped: true }];
      r.testError = 'ReferenceError: x is not defined';
      window.__reqTab.ui.resTab = 'tests'; window.__reqTab.ui.reqTab = 'tests'; HD.renderActiveTab();`);
    await run('toasts', `document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); for (const t of ['info', 'success', 'warn', 'error']) HD.toast('This is a ' + t + ' message with some detail', t, 60000);`);
    await run('context menu', `document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); HD.menu(document.querySelector('.btn'), [{ label: 'Rename', hint: 'F2' }, { label: 'Checked', checked: true }, { separator: true }, { label: 'Delete', danger: true }]);`);
    for (const section of ['general', 'proxy', 'certificates', 'appearance', 'data', 'about']) await run('settings: ' + section, `HD.showSettings('${section}'); await wait(150);`);
    await run('sidebar collections', `document.querySelectorAll('.modal-overlay').forEach((n) => n.remove());
      const c = HD.S.ws.collections[0]; const methods = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
      if (!c.items.some((i) => i.name === 'audit-methods')) { c.items.push(...methods.map((m) => HD.newRequestItem(m.toLowerCase() + ' item', { method: m }))); c.items.push(HD.newRequestItem('ws item', HD.newWebSocketDef())); c.items.push({ ...HD.newFolder('audit-methods') }); }
      HD.S.ws.ui.sidebarTab = 'collections'; HD.S.ws.ui.expanded = HD.S.ws.ui.expanded || {}; HD.S.ws.ui.expanded[c.id] = true; HD.renderSidebar();`);
    await run('sidebar environments', `HD.S.ws.ui.sidebarTab = 'environments'; HD.renderSidebar();`);
    await run('sidebar history', `HD.S.ws.ui.sidebarTab = 'history'; HD.renderSidebar();`);
    await run('console', `HD.log('info', 'info line'); HD.log('warn', 'warn line'); HD.log('error', 'error line'); HD.log('net', 'GET x -> 200'); HD.log('log', 'script output'); HD.S.ws.ui.consoleOpen = false; HD.command('toggle-console');`);
    await run('websocket', `HD.command('toggle-console');
      if (!window.__wsTab) { window.__wsTab = HD.openNewWebSocket(); window.__wsTab.draft.request.url = 'ws://127.0.0.1:${P}/x'; window.__wsTab.ui.wsDraft = '{"hello":1}'; HD.renderActiveTab(); await wait(100);
        document.querySelector('.ws-view .send-btn').click(); await wait(300);
        [...document.querySelectorAll('.ws-msg-bar .btn')].find((b) => b.textContent === 'Send').click(); await wait(200); }
      else { HD.S.ws.activeTabId = window.__wsTab.id; HD.renderTabBar(); HD.renderActiveTab(); }`);
    await run('streaming events', `
      if (!window.__sseTab) { window.__sseTab = HD.openNewRequest({ method: 'GET', url: 'http://127.0.0.1:${P}/sse' }, 'SSE'); HD.renderActiveTab(); await wait(100); document.querySelector('.send-btn').click(); await wait(500); }
      else { HD.S.ws.activeTabId = window.__sseTab.id; HD.renderTabBar(); HD.renderActiveTab(); }`);
    await run('runner', `HD.openRunner(HD.S.ws.collections[0].id); await wait(150);`);
    await run('secret scan', `HD.command('secrets'); await wait(200);`);
    await run('audit log', `HD.command('audit'); await wait(200);`);
    await run('codegen', `HD.S.ws.activeTabId = window.__reqTab.id; HD.renderActiveTab(); await wait(100); HD.command('codegen'); await wait(200);`);
    const errors = all.filter((x) => x.error);
    const fails = all.filter((x) => !x.error);
    for (const e of errors) console.log(`Could not check "${e.state}": ${e.error}`);
    for (const f of fails) console.log(`${f.ratio}:1 (needs ${f.need}) ${f.state}: ${f.where} "${f.text}" ${f.fg} on ${f.bg}`);
    console.log(fails.length || errors.length ? `\n${fails.length} contrast problem(s), ${errors.length} screen(s) not checked.` : 'All text meets WCAG AA contrast in the light and dark themes.');
    fs.rmSync(process.env.HTTPDASH_DATA_DIR, { recursive: true, force: true });
    app.exit(fails.length || errors.length ? 1 : 0);
  });
});
require(path.join(root, 'src', 'main', 'main.js'));
