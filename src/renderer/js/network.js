'use strict';

/* The Timeline's Network section: where a request went (see src/core/network.js) — the name's
   aliases and addresses, the address it connected to split into octets with its segment, the
   adapter it left from — and a route trace on demand. */
(() => {
  const { h } = HD;

  const KIND = {
    private: 'Private', shared: 'Shared / VPN', loopback: 'Loopback', 'link-local': 'Link-local', public: 'Public',
    multicast: 'Multicast', benchmark: 'Benchmark', unspecified: 'Unspecified',
  };

  // 10 · 42 · 7 · 31 with the segment's octets marked: for 10.42.7.0/24, the first three.
  const octets = (a) => {
    if (!a) return null;
    const bits = Number(String(a.segment || '').split('/')[1]);
    if (a.family === 4 && a.octets) {
      return h('span.net-octets', { title: `${a.segment}: the first ${bits} bits are the segment, the rest the host` },
        a.octets.map((o, i) => [i ? h('span.net-dot', '.') : null, h(`span.net-octet${i * 8 < bits ? (i * 8 + 8 <= bits ? '.seg' : '.part') : ''}`, String(o))]));
    }
    return h('span.mono', a.address);
  };

  const kindPill = (a) => (a ? h(`span.pill.net-kind.net-${a.kind}`, { title: a.label }, KIND[a.kind] || a.kind) : null);
  const own = (a) => (a && a.ownSegment ? h('span.pill.net-own', { title: `On this computer's own segment: ${a.ownSegment.cidr} on ${a.ownSegment.adapter}` }, `your segment · ${a.ownSegment.adapter}`) : null);
  const ttl = (s) => (s == null ? null : h('span.muted.small', { title: 'How long DNS lets this answer be cached' }, `TTL ${s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`}`));

  HD.traceRoute = (args) => window.api.traceRoute(args);

  const row = (label, ...content) => h('div.net-row', h('div.net-label', label), h('div.net-value', ...content));

  /** net: the `network` of a request's result. */
  HD.networkSection = (net) => {
    const box = h('div.timeline-section.net');
    box.appendChild(h('div.timeline-title', 'Network'));
    const c = net.connected;
    const r = net.resolution;

    if (net.viaProxy) {
      box.appendChild(h('div.info-box.small', 'Sent through a proxy: the address below is the proxy\'s. The service\'s own address is only known to the proxy.'));
    }
    if (r) {
      box.appendChild(row('Host', h('span.mono', net.host),
        r.cnames.length ? h('span.muted.small', ` alias of ${r.cnames.join(' → ')}`) : null));
    }
    if (c) {
      box.appendChild(row(net.viaProxy ? 'Proxy' : 'Connected to',
        h('div.net-addr', octets(c), h('span.mono.small.muted', c.segment), kindPill(c), own(c)),
        c.ptr && c.ptr.length ? h('div.muted.small', `Reverse DNS: ${c.ptr.join(', ')}`) : null));
    }
    if (net.local) {
      box.appendChild(row('From', h('div.net-addr', h('span.mono', net.local.address),
        net.local.adapter ? h('span.muted.small', `${net.local.adapter}${net.local.cidr ? ` · ${net.local.cidr}` : ''}`) : null)));
    }
    if (r && r.addresses.length) {
      const list = h('div.net-list', r.addresses.map((a) => h(`div.net-addr${a.used ? '.used' : ''}`,
        octets(a), h('span.mono.small.muted', a.segment), kindPill(a), ttl(a.ttl), own(a),
        a.used ? h('span.pill.added', 'connected') : null)));
      box.appendChild(row(`Resolves to (${r.addresses.length})`, list,
        r.addresses.length > 1 ? h('div.muted.small', 'In the order this computer\'s resolver gave them; a client tries them in turn.') : null));
    } else if (r && r.error) {
      box.appendChild(row('Resolves to', h('span.text-error.small', r.error)));
    }
    if (r && r.splitDns) {
      box.appendChild(h('div.discovery-warning', `DNS servers asked directly give ${r.direct.join(', ')}, not what this computer's resolver gives (hosts file, VPN or split DNS). Requests use the resolver's answer.`));
    }

    // The route, hop by hop, when asked for: it takes seconds and firewalls often hide hops.
    const route = h('div.net-route');
    const host = net.host || (c && c.address);
    if (host) {
      const run = async () => {
        HD.clear(route).appendChild(h('div.runner-progress', h('div.spinner.small'), `Tracing the route to ${host}… (up to a minute)`));
        try {
          const hops = await HD.traceRoute({ host });
          HD.clear(route).appendChild(hops.length ? h('div.table-wrap.no-pad', h('table.data-table.net-hops',
            h('thead', h('tr', h('th.num', 'Hop'), h('th', 'Address'), h('th', 'Segment'), h('th', 'Kind'), h('th.num', 'Time'))),
            h('tbody', hops.map((x) => h('tr',
              h('td.num', String(x.hop)),
              h('td', x.address ? octets(x) : h('span.muted', 'no answer')),
              h('td.mono.small', x.segment || ''),
              h('td', x.address ? kindPill(x) : null),
              h('td.num', x.ms == null ? '—' : HD.formatMs(x.ms)))))))
            : h('div.muted.small', 'No hops came back.'));
        } catch (e) {
          HD.clear(route).appendChild(h('div.test-script-error', HD.cleanErr(e)));
        }
      };
      box.appendChild(h('div.button-row.net-actions', HD.button('Trace route', run, { small: true, icon: 'pulse', title: `Runs traceroute to ${host}` }),
        h('span.muted.small', 'Each router on the way, with its segment. Some networks don\'t answer.')));
      box.appendChild(route);
    }
    return box;
  };
})();
