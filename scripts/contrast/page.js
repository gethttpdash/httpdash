// Injected into the app window by main.js.
// Injected into the app window: finds text whose contrast with its background is below WCAG AA.
window.__contrastAudit = (stateName) => {
  const parse = (c) => {
    let m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /color\(srgb ([^)]+)\)/.exec(c);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const backgroundOf = (el) => {
    const layers = [];
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return { bg: base, opacity };
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const describe = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) parts.unshift(n.tagName.toLowerCase() + (n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : ''));
    return parts.join(' > ');
  };
  const fails = [];
  const check = (el, fgColor, text, kind) => {
    const cs = getComputedStyle(el);
    const fg = parse(fgColor);
    if (!fg) return;
    const { bg, opacity } = backgroundOf(el);
    const effective = over({ ...fg, a: fg.a * opacity }, bg);
    const r = ratio(effective, bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (r < need) fails.push({ state: stateName, where: describe(el), kind, text: text.trim().slice(0, 40), ratio: Math.round(r * 100) / 100, need, fg: fgColor, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest(':disabled,[aria-disabled="true"],.CodeMirror-measure,.CodeMirror-cursors,svg')) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent).join(' ');
    if (own) check(el, getComputedStyle(el).color, own, 'text');
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder && !el.value) check(el, getComputedStyle(el, '::placeholder').color, el.placeholder, 'placeholder');
  }
  return fails;
};
