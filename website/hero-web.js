'use strict';

// The hero's background: a web of services with requests (GET, POST, PUT, PATCH, DELETE) streaming
// along it, hopping from node to node and bouncing in where they land. Everything sits at a depth
// and is out of focus away from the focal plane, except under a lens that follows the pointer (and
// drifts on its own without one): there things are sharp, a little magnified, and the requests show
// their paths. The pointer nudges the web aside, and a click sends a burst of requests.
// It fades behind the headline, sleeps when off screen or hidden, stays still for visitors who
// prefer less motion, and stops with the hero's pause button.
(() => {
  const hero = document.querySelector('.hero');
  const copy = document.querySelector('.hero-copy');
  if (!hero || !copy || !window.HTMLCanvasElement) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'hero-web';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Older browsers without roundRect: a plain rectangle is fine.
  if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function roundRect(x, y, w, h) { this.rect(x, y, w, h); };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const METHODS = ['GET', 'GET', 'GET', 'POST', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const PATHS = {
    GET: ['/orders/ORD-1001', '/lots?state=released', '/healthz', '/machines/M-12', '/v1/catalog/services'],
    POST: ['/payments', '/orders', '/lots/L-4711/hold', '/oauth/token'],
    PUT: ['/orders/ORD-1001', '/recipes/R-7', '/settings'],
    PATCH: ['/lots/L-4711', '/users/42'],
    DELETE: ['/cache', '/sessions/9f2c', '/orders/ORD-0999'],
  };
  const COLORS = {
    light: { GET: '#107435', POST: '#a34b08', PUT: '#1557e6', PATCH: '#7935ed', DELETE: '#c42020', line: '22,24,29', lens: '194,65,12' },
    dark: { GET: '#4ade80', POST: '#fb923c', PUT: '#60a5fa', PATCH: '#a78bfa', DELETE: '#f87171', line: '236,238,242', lens: '255,143,82' },
  };
  const BLUR_LEVELS = 5;
  const FONT = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  let W = 0;
  let H = 0;
  let dpr = 1;
  let nodes = [];
  let packets = [];
  let ripples = [];
  let sprites = {};
  let theme = 'light';
  let textBox = null; // where the headline sits, to fade the web behind it
  let pointer = null; // { x, y } while the pointer is over the hero
  let lens = { x: 0, y: 0, r: 150 };
  let running = false;
  let visible = true;
  let paused = false;
  let last = 0;
  let spawnIn = 0;
  let t = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- Sprites: each method's pill, from sharp to very out of focus --------------------------

  function pill(method, color) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = FONT;
    const w = Math.ceil(g.measureText(method).width) + 14;
    const h = 20;
    c.width = w * dpr;
    c.height = h * dpr;
    g.scale(dpr, dpr);
    g.font = FONT;
    g.fillStyle = `${color}22`;
    g.strokeStyle = `${color}aa`;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(0.5, 0.5, w - 1, h - 1, 10);
    g.fill();
    g.stroke();
    g.fillStyle = color;
    g.textBaseline = 'middle';
    g.fillText(method, 7, h / 2 + 0.5);
    return { c, w, h };
  }

  // Out of focus: the pill shrunk to a few pixels and smoothly scaled back up, twice, which blurs
  // it the same way in every browser (canvas filters aren't everywhere yet).
  function defocus(base, level) {
    if (!level) return base;
    const pad = 3 + level * 2;
    const w = base.w + pad * 2;
    const h = base.h + pad * 2;
    const full = document.createElement('canvas');
    full.width = w * dpr;
    full.height = h * dpr;
    const g = full.getContext('2d');
    const k = 1 / (1 + level * 1.15);
    const small = document.createElement('canvas');
    small.width = Math.max(2, Math.round(w * dpr * k));
    small.height = Math.max(2, Math.round(h * dpr * k));
    const sg = small.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(base.c, pad * dpr * k, pad * dpr * k, base.w * dpr * k, base.h * dpr * k);
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, w * dpr, h * dpr);
    return { c: full, w, h };
  }

  function buildSprites() {
    sprites = {};
    for (const m of Object.keys(PATHS)) {
      const base = pill(m, COLORS[theme][m]);
      sprites[m] = Array.from({ length: BLUR_LEVELS }, (_, i) => defocus(base, i));
    }
  }

  // ---- The web ---------------------------------------------------------------------------------

  function layout() {
    const r = hero.getBoundingClientRect();
    const cr = copy.getBoundingClientRect();
    W = Math.round(r.width);
    // Only the part behind the headline and buttons: the screenshot below covers the rest.
    H = Math.round(Math.min(r.height, cr.bottom - r.top + 120));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const h1 = copy.querySelector('h1');
    const hr = (h1 || copy).getBoundingClientRect();
    textBox = { x: hr.left - r.left - 20, y: hr.top - r.top - 30, w: hr.width + 40, h: cr.bottom - hr.top + 30 };
    // Nodes on a jittered grid, so they cover the hero evenly; fewer on a phone.
    const area = W * H;
    const count = clamp(Math.round(area / 26000), 14, 46);
    const cols = Math.max(3, Math.round(Math.sqrt(count * (W / H))));
    const rows = Math.max(2, Math.ceil(count / cols));
    nodes = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = ((i + 0.5) / cols) * W + rand(-0.3, 0.3) * (W / cols);
        const y = ((j + 0.5) / rows) * H + rand(-0.3, 0.3) * (H / rows);
        nodes.push({ x, y, hx: x, hy: y, z: rand(0, 1), vx: rand(-6, 6), vy: rand(-6, 6), pulse: 0 });
      }
    }
    packets = [];
    ripples = [];
    lens = { x: W / 2, y: H * 0.45, r: clamp(W * 0.12, 90, 170) };
    buildSprites();
  }

  const linkDist = () => clamp(Math.min(W, H) * 0.42, 120, 230);

  function neighbors(n) {
    const d = linkDist();
    return nodes.filter((o) => o !== n && Math.hypot(o.x - n.x, o.y - n.y) < d);
  }

  function spawn(from) {
    const a = from || pick(nodes);
    const ns = neighbors(a);
    if (!ns.length) return;
    const method = pick(METHODS);
    packets.push({ method, path: pick(PATHS[method]), a, b: pick(ns), p: 0, speed: rand(0.45, 0.9), hops: Math.round(rand(3, 7)), bounce: 0, life: 1, born: 0 });
  }

  // ---- Focus -----------------------------------------------------------------------------------

  // Magnifies what's under the lens, a little, like a loupe.
  function warp(x, y) {
    const dx = x - lens.x;
    const dy = y - lens.y;
    const d = Math.hypot(dx, dy);
    if (d >= lens.r) return [x, y, 0];
    const k = 1 - d / lens.r;
    const s = 1 + 0.22 * k * k;
    return [lens.x + dx * s, lens.y + dy * s, k];
  }

  const focusZ = () => 0.5 + Math.sin(t * 0.25) * 0.3;
  const blurOf = (z, inLens) => (inLens > 0.15 ? 0 : clamp(Math.round(Math.abs(z - focusZ()) * (BLUR_LEVELS + 1)), 0, BLUR_LEVELS - 1));

  // Fainter behind the headline, so the words stay easy to read.
  function fade(x, y) {
    const b = textBox;
    if (!b) return 1;
    const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
    const d = Math.hypot(dx, dy);
    return 0.1 + 0.9 * clamp(d / 120, 0, 1);
  }

  // ---- Frame -----------------------------------------------------------------------------------

  function step(dt) {
    t += dt;
    // The lens follows the pointer, or wanders slowly on its own.
    const target = pointer || { x: W * (0.5 + 0.38 * Math.sin(t * 0.17)), y: H * (0.5 + 0.32 * Math.sin(t * 0.23 + 1)) };
    lens.x += (target.x - lens.x) * Math.min(1, dt * (pointer ? 9 : 1.5));
    lens.y += (target.y - lens.y) * Math.min(1, dt * (pointer ? 9 : 1.5));

    for (const n of nodes) {
      // Drift around a home position; the pointer pushes nodes away.
      n.vx += (n.hx - n.x) * 0.6 * dt + rand(-4, 4) * dt;
      n.vy += (n.hy - n.y) * 0.6 * dt + rand(-4, 4) * dt;
      if (pointer) {
        const dx = n.x - pointer.x;
        const dy = n.y - pointer.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 140) {
          const f = (1 - d / 140) * 900 * dt;
          n.vx += (dx / d) * f;
          n.vy += (dy / d) * f;
        }
      }
      n.vx *= 1 - Math.min(1, dt * 1.8);
      n.vy *= 1 - Math.min(1, dt * 1.8);
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.pulse = Math.max(0, n.pulse - dt * 1.6);
    }

    spawnIn -= dt;
    const want = clamp(Math.round(nodes.length / 3), 5, 14);
    if (spawnIn <= 0 && packets.length < want) { spawn(); spawnIn = rand(0.35, 0.9); }

    for (const p of packets) {
      p.born = Math.min(1, p.born + dt * 3);
      p.bounce = Math.max(0, p.bounce - dt * 2.6);
      const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) || 1;
      p.p += (p.speed * 160 * dt) / len;
      if (p.p >= 1) {
        // Landed: bounce, ripple through the node, and go on to another neighbor.
        p.b.pulse = 1;
        ripples.push({ n: p.b, r: 0, a: 1, color: COLORS[theme][p.method] });
        p.bounce = 1;
        p.hops -= 1;
        const ns = neighbors(p.b).filter((o) => o !== p.a);
        if (p.hops <= 0 || !ns.length) p.life = 0;
        else { p.a = p.b; p.b = pick(ns); p.p = 0; }
      }
    }
    packets = packets.filter((p) => p.life > 0);
    for (const r of ripples) { r.r += dt * 70; r.a -= dt * 1.4; }
    ripples = ripples.filter((r) => r.a > 0);
  }

  // A spring that overshoots and settles: how a request bounces in.
  const springScale = (b) => 1 + 0.45 * Math.sin(b * Math.PI * 2.2) * b;
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2);

  function draw() {
    const col = COLORS[theme];
    ctx.clearRect(0, 0, W, H);
    const d = linkDist();
    const busy = new Set(packets.map((p) => `${nodes.indexOf(p.a)}-${nodes.indexOf(p.b)}`));

    // Links: faint lines, sharper and stronger near the lens; dashes stream along busy ones.
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > d) continue;
        const [ax, ay, ka] = warp(a.x, a.y);
        const [bx, by, kb] = warp(b.x, b.y);
        const near = Math.max(ka, kb);
        const depth = 1 - Math.abs((a.z + b.z) / 2 - focusZ());
        const alpha = (1 - dist / d) * (0.05 + 0.1 * depth + 0.25 * near) * fade((ax + bx) / 2, (ay + by) / 2);
        const flowing = busy.has(`${i}-${j}`) || busy.has(`${j}-${i}`);
        ctx.strokeStyle = `rgba(${col.line},${alpha * (flowing ? 2.2 : 1)})`;
        if (flowing) { ctx.setLineDash([2, 7]); ctx.lineDashOffset = -t * 40; } else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Nodes: small dots, bigger and softer out of focus; a ring when a request lands.
    for (const n of nodes) {
      const [x, y, k] = warp(n.x, n.y);
      const blur = Math.abs(n.z - focusZ()) * (k > 0.15 ? 0 : 1);
      const r = 1.6 + blur * 3 + n.pulse * 2.5 + k * 1.2;
      ctx.fillStyle = `rgba(${col.line},${(0.18 + 0.25 * (1 - blur) + 0.3 * k) * fade(x, y) * (1 - blur * 0.5)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const rp of ripples) {
      const [x, y] = warp(rp.n.x, rp.n.y);
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = rp.a * 0.45 * fade(x, y);
      ctx.beginPath();
      ctx.arc(x, y, 4 + rp.r * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Requests, farthest from the focal plane first.
    const order = packets.map((p) => ({ p, z: p.a.z + (p.b.z - p.a.z) * p.p })).sort((u, v) => Math.abs(v.z - focusZ()) - Math.abs(u.z - focusZ()));
    for (const { p, z } of order) {
      const e = ease(clamp(p.p, 0, 1));
      const [x, y, k] = warp(p.a.x + (p.b.x - p.a.x) * e, p.a.y + (p.b.y - p.a.y) * e);
      const s = springScale(p.bounce) * (0.6 + 0.4 * p.born) * (1 + 0.25 * k);
      const alpha = p.born * fade(x, y) * (0.35 + 0.65 * Math.max(k, 1 - Math.abs(z - focusZ())));
      ctx.globalAlpha = clamp(alpha, 0, 1);
      if (k > 0.15) {
        // In the lens: sharp, with the request's path.
        const label = `${p.method} ${p.path}`;
        ctx.font = FONT;
        const w = ctx.measureText(label).width + 14;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        ctx.fillStyle = theme === 'dark' ? 'rgba(23,24,30,0.85)' : 'rgba(255,255,255,0.85)';
        ctx.strokeStyle = col[p.method];
        ctx.beginPath();
        ctx.roundRect(-w / 2, -10, w, 20, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = col[p.method];
        ctx.textBaseline = 'middle';
        ctx.fillText(label, -w / 2 + 7, 0.5);
        ctx.restore();
      } else {
        const sp = sprites[p.method][blurOf(z, k)];
        const w = sp.w * s;
        const h = sp.h * s;
        ctx.drawImage(sp.c, x - w / 2, y - h / 2, w, h);
      }
      ctx.globalAlpha = 1;
    }

    // The lens itself: a thin glass ring, fainter behind the headline.
    ctx.strokeStyle = `rgba(${col.lens},${(pointer ? 0.28 : 0.14) * fade(lens.x, lens.y)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${col.lens},${(pointer ? 0.1 : 0.05) * fade(lens.x, lens.y)})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(lens.x, lens.y, lens.r - 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // ---- When it runs ----------------------------------------------------------------------------

  function update() {
    const should = visible && !document.hidden && !paused && !reduce.matches;
    if (should && !running) { running = true; last = 0; requestAnimationFrame(frame); }
    if (!should) running = false;
    // Without motion, one still frame of the web with a few requests on it.
    if (!should && !packets.length) {
      for (let i = 0; i < Math.min(8, nodes.length); i++) spawn();
      for (const p of packets) { p.p = rand(0.2, 0.8); p.born = 1; }
      draw();
    }
  }

  const setTheme = () => {
    const forced = document.documentElement.dataset.theme;
    theme = forced === 'dark' || (!forced && darkQuery.matches) ? 'dark' : 'light';
    buildSprites();
    if (!running) draw();
  };

  layout();
  setTheme();
  if (window.IntersectionObserver) {
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; update(); }).observe(canvas);
  }
  document.addEventListener('visibilitychange', update);
  reduce.addEventListener('change', update);
  darkQuery.addEventListener('change', setTheme);
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { layout(); if (!running) update(); }, 150); });

  // The pointer: the lens and a nudge while it moves over the hero; a click sends a burst.
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  hero.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') { const p = local(e); pointer = p.y <= H ? p : null; } });
  hero.addEventListener('pointerleave', () => { pointer = null; });
  hero.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button, input')) return;
    const p = local(e);
    if (p.y > H || !running) return;
    const near = nodes.reduce((best, n) => (Math.hypot(n.x - p.x, n.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? n : best), nodes[0]);
    near.pulse = 1;
    ripples.push({ n: near, r: 0, a: 1, color: COLORS[theme].POST });
    for (let i = 0; i < 5; i++) spawn(near);
    for (const q of packets.slice(-5)) q.bounce = 1;
  });

  // The hero's pause button stops the web too.
  window.addEventListener('hero:paused', (e) => { paused = !!e.detail; update(); });
  update();
})();
