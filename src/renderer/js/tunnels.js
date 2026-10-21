'use strict';

/* Tunnels into internal networks (see src/core/tunnels.js): Settings → Tunnels, an environment's
   tunnel, and a status bar light while one is open. */
(() => {
  const { h } = HD;
  const S = HD.S;

  let status = [];
  const results = new Map(); // tunnel id -> the last Check/Open result, kept while the status changes
  // Status lines on screen, redrawn when a tunnel opens, closes or fails.
  const drawers = new Set();
  HD.on('tunnels', () => { for (const d of drawers) { if (d.el.isConnected) d.draw(); else drawers.delete(d); } });
  const byId = (id) => status.find((x) => x.id === id) || null;
  window.api.onTunnelStatus((list) => { status = list || []; HD.emit('tunnels'); });
  window.api.tunnelStatus().then((list) => { status = list || []; HD.emit('tunnels'); }).catch(() => {});

  HD.tunnels = () => (S.ws.tunnels = S.ws.tunnels || []);

  /** The tunnel choice for an environment's requests: its own tunnel, 'none', or 'auto' (by host). */
  HD.tunnelIdFor = (env) => (env && env.tunnelId) || 'auto';

  const newTunnel = (type) => ({
    id: HD.uid(), name: type === 'ssh' ? 'Jump host' : 'SOCKS proxy', type, enabled: true,
    ssh: { host: '', port: 22, user: '', identityFile: '', jump: '', acceptNewHostKey: false },
    socks: { host: '', port: 1080, username: '', password: '' },
    hosts: [],
  });

  const STATE = {
    up: ['ok', 'Open'], starting: ['warn', 'Opening…'], ready: ['ok', 'Ready'], stopped: ['muted', 'Closed: opens on first use'], error: ['err', 'Could not open'],
  };

  HD.renderTunnelSettings = (panel, rerender) => {
    const list = HD.tunnels();
    const save = () => HD.save();
    panel.appendChild(h('div.setting-help.tunnel-intro',
      'Reach services on a private network (a plant, a data center, a cluster) without a VPN. Requests to the hosts you list go through the tunnel, and their names are resolved on the far side. An environment can also send all its requests through one tunnel.'));

    for (const t of list) {
      const field = (obj, key, label, placeholder, type = 'text', help) => h('label.field', h('span', label),
        h('input.input', { type, value: obj[key] == null ? '' : obj[key], placeholder, spellcheck: 'false', autocomplete: 'off',
          oninput: (e) => { obj[key] = type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value.trim(); save(); } }),
        help ? h('span.field-help', help) : null);
      const statusEl = h('div.tunnel-status');
      const target = h('input.input.input-med', { placeholder: 'orders.mes.corp:443', spellcheck: 'false', 'aria-label': 'Host to try through the tunnel' });
      const drawStatus = (extra) => {
        if (extra !== undefined) results.set(t.id, extra);
        const shown = results.get(t.id);
        const st = byId(t.id);
        const [cls, label] = STATE[(st && st.state) || 'stopped'] || STATE.stopped;
        HD.clear(statusEl).append(...[
          h(`span.pill.tunnel-${cls}`, label),
          st && st.state === 'up' && st.port ? h('span.muted.small', `SOCKS on 127.0.0.1:${st.port}`) : null,
          st && st.error && !shown ? h('span.text-error.small.tunnel-error', st.error) : null,
          shown ? h(`span.small.tunnel-error.${shown.ok ? 'text-ok' : 'text-error'}`, shown.text) : null,
        ].filter(Boolean));
      };
      const test = async () => {
        drawStatus({ ok: true, text: target.value.trim() ? `Opening and trying ${target.value.trim()}…` : 'Opening…' });
        try {
          const r = await window.api.testTunnel({ id: t.id, target: target.value.trim() || null });
          status = r.status || status;
          drawStatus({ ok: true, text: target.value.trim() ? `Reached ${target.value.trim()} through it in ${HD.formatMs(r.ms)}` : `Open in ${HD.formatMs(r.ms)}` });
        } catch (e) {
          drawStatus({ ok: false, text: HD.cleanErr(e) });
        }
      };
      drawers.add({ el: statusEl, draw: () => drawStatus() });

      const ssh = t.ssh = t.ssh || {};
      const socks = t.socks = t.socks || {};
      panel.appendChild(h('div.tunnel-card',
        h('div.tunnel-head',
          h('input.input.tunnel-name', { value: t.name, 'aria-label': 'Tunnel name', oninput: (e) => { t.name = e.target.value; save(); } }),
          HD.select([['ssh', 'SSH jump host'], ['socks5', 'SOCKS5 proxy']], t.type, (v) => { t.type = v; save(); rerender(); }, 'select-small'),
          h('label.check', h('input', { type: 'checkbox', checked: t.enabled !== false, onchange: (e) => { t.enabled = e.target.checked; save(); } }), 'On'),
          h('span.spacer'),
          HD.button('Remove', async () => {
            if (!(await HD.confirm('Remove tunnel', `Remove "${t.name}"? Environments that use it go back to choosing by host.`, { danger: true, okLabel: 'Remove' }))) return;
            list.splice(list.indexOf(t), 1);
            for (const env of S.ws.environments) if (env.tunnelId === t.id) delete env.tunnelId;
            save();
            rerender();
          }, { small: true, ghost: true })),
        t.type === 'ssh'
          ? h('div.dep-grid',
            field(ssh, 'host', 'SSH host', 'jump.mes.corp'),
            field(ssh, 'user', 'User', 'default: your ssh config'),
            field(ssh, 'port', 'Port', '22', 'number'),
            field(ssh, 'identityFile', 'Key file', 'default: your ssh agent and config', 'text', 'Optional, e.g. ~/.ssh/id_ed25519. Passwords are not asked for: use a key.'),
            field(ssh, 'jump', 'Through other jump hosts first', 'user@bastion.corp:22', 'text', 'Optional (ssh -J); several separated by commas.'))
          : h('div.dep-grid',
            field(socks, 'host', 'SOCKS host', '127.0.0.1'),
            field(socks, 'port', 'Port', '1080', 'number'),
            field(socks, 'username', 'User name', 'optional'),
            field(socks, 'password', 'Password', 'optional', 'password')),
        t.type === 'ssh' ? h('label.check', h('input', { type: 'checkbox', checked: !!ssh.acceptNewHostKey, onchange: (e) => { ssh.acceptNewHostKey = e.target.checked; save(); } }),
          'Accept a new host key the first time (a changed key is always refused)') : null,
        h('label.field', h('span', 'Send these hosts through it'),
          h('textarea.input.tunnel-hosts', {
            rows: 3, spellcheck: 'false', placeholder: '*.mes.corp\n10.42.0.0/16\nconsul.plant.local', value: (t.hosts || []).join('\n'),
            oninput: (e) => { t.hosts = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); save(); },
          }),
          h('span.field-help', 'One per line: a name with * wildcards, or an address range such as 10.42.0.0/16. Service discovery, OAuth and imports to these hosts go through it too.')),
        h('div.button-row.tunnel-actions',
          HD.button(t.type === 'ssh' ? 'Open' : 'Check', test, { small: true, icon: 'play' }),
          target, h('span.muted.small', 'optional: a host:port to reach through it'),
          t.type === 'ssh' ? HD.button('Close', async () => { status = await window.api.stopTunnel({ id: t.id }); results.delete(t.id); drawStatus(); }, { small: true, ghost: true }) : null),
        statusEl));
      drawStatus();
    }
    panel.appendChild(h('div.button-row',
      HD.button('Add SSH jump host', () => { list.push(newTunnel('ssh')); save(); rerender(); }, { small: true, icon: 'plus' }),
      HD.button('Add SOCKS5 proxy', () => { list.push(newTunnel('socks5')); save(); rerender(); }, { small: true, icon: 'plus' })));
    if (!list.length) panel.appendChild(h('div.muted.small', 'No tunnels yet.'));
  };

  /** The environment's tunnel choice, under its color. */
  HD.envTunnelRow = (env, touch) => {
    const list = HD.tunnels();
    const options = [['', 'By host (each tunnel\'s list)'], ['none', 'No tunnel'], ...list.map((t) => [t.id, `All requests through ${t.name}`])];
    return h('div.panel-pad.env-color-row',
      h('span.small', 'Tunnel'),
      HD.select(options, env.tunnelId || '', (v) => { if (v) env.tunnelId = v; else delete env.tunnelId; touch(); }, 'select-small'),
      h('span.muted.small', list.length ? 'Which requests of this environment go through a tunnel (Settings → Tunnels).' : 'No tunnels yet: add one in Settings → Tunnels to reach services on a private network.'));
  };

  /** A status bar light while a tunnel is open, opening or failed. */
  HD.tunnelIndicator = () => {
    const live = status.filter((s) => s.state === 'up' || s.state === 'starting' || s.state === 'error');
    if (!live.length) return null;
    const err = live.find((s) => s.state === 'error');
    const label = live.length === 1 ? `Tunnel: ${live[0].name}` : `${live.length} tunnels`;
    return HD.button(label, () => HD.showSettings('tunnels'), {
      icon: 'pulse', ghost: true, small: true, class: err ? 'tunnel-light has-errors' : 'tunnel-light',
      title: live.map((s) => `${s.name}: ${(STATE[s.state] || STATE.stopped)[1]}${s.error ? ` (${s.error})` : ''}`).join('\n'),
    });
  };
})();
