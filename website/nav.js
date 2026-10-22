'use strict';

// The site menu on phones: the header's links are hidden there, and the menu button shows them.
(() => {
  const header = document.querySelector('.nav');
  const btn = header && header.querySelector('.nav-toggle');
  if (!btn) return;
  const set = (open) => {
    header.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  btn.addEventListener('click', () => set(!header.classList.contains('nav-open')));
  // A link that's picked, Escape, or a tap outside the header closes it.
  header.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && header.classList.contains('nav-open')) { set(false); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) set(false); });
  window.matchMedia('(min-width: 721px)').addEventListener('change', (e) => { if (e.matches) set(false); });
})();
