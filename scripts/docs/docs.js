'use strict';

// Documentation pages: the topic filter, the "On this page" highlight, and the Topics menu on phones.
(() => {
  // Filter the topics by their names and section titles.
  const filter = document.querySelector('.docs-filter');
  if (filter) {
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      let any = false;
      document.querySelectorAll('.docs-topics ul').forEach((ul) => {
        let shown = 0;
        ul.querySelectorAll('a').forEach((a) => {
          const hit = !q || a.textContent.toLowerCase().includes(q) || (a.dataset.search || '').includes(q);
          a.parentElement.hidden = !hit;
          if (hit) shown++;
        });
        ul.hidden = !shown;
        const label = ul.previousElementSibling;
        if (label && label.classList.contains('docs-group')) label.hidden = !shown;
        if (shown) any = true;
      });
      const none = document.querySelector('.docs-none');
      if (none) none.hidden = any;
    });
  }

  // On phones the topics start folded, apart from on the overview.
  const toggle = document.querySelector('.docs-topics-toggle');
  if (toggle && window.matchMedia('(max-width: 820px)').matches && !document.querySelector('.docs-layout-index')) toggle.open = false;

  // Keep the current topic in view in the left column.
  const current = document.querySelector('.docs-topics a.current');
  const left = document.querySelector('.docs-left');
  if (current && left && left.scrollHeight > left.clientHeight) left.scrollTop = current.offsetTop - left.clientHeight / 3;

  // Highlight the section being read in "On this page".
  const links = [...document.querySelectorAll('.docs-toc a[href^="#"]:not(.docs-top)')];
  const targets = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (!targets.length) return;
  const mark = () => {
    const line = 110;
    let active = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top - line <= 0) active = t;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) active = targets[targets.length - 1];
    links.forEach((a) => a.classList.toggle('active', a.hash === `#${active.id}`));
  };
  let pending = false;
  window.addEventListener('scroll', () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; mark(); }); } }, { passive: true });
  mark();
})();
