'use strict';

// Suggest the download for the visitor's platform, wire up copy buttons, and keep the year current.
(() => {
  const ua = navigator.userAgent || '';
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /Win/i.test(platform) || /Windows/i.test(ua) ? 'windows'
    : /Mac/i.test(platform) || /Mac OS X/i.test(ua) ? 'mac'
    : /Linux/i.test(platform) && !/Android/i.test(ua) ? 'linux' : null;
  const primary = document.getElementById('primary-download');
  if (os && primary) {
    primary.textContent = `Download for ${{ windows: 'Windows', mac: 'macOS', linux: 'Linux' }[os]}`;
    const card = document.querySelector(`.dl-card[data-os="${os}"]`);
    if (card) card.classList.add('suggested');
  }

  document.querySelectorAll('.copy[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  });

  // The hero's messages: one every few seconds, paused while the pointer or focus is on them, by the
  // pause button, and from the start for visitors who ask for less motion.
  const carousel = document.querySelector('.hero-carousel');
  if (carousel) {
    const slides = [...carousel.querySelectorAll('.hero-slide')];
    const dots = [...carousel.querySelectorAll('.hero-dot')];
    const live = carousel.querySelector('.hero-messages');
    const pause = carousel.querySelector('.hero-pause');
    let current = 0;
    let timer = null;
    let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let holding = false;
    const show = (i) => {
      current = (i + dots.length) % dots.length;
      for (const el of slides) {
        const on = Number(el.dataset.slide) === current;
        el.classList.toggle('is-active', on);
        if (on) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
      }
      dots.forEach((d, n) => { if (n === current) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current'); });
    };
    const schedule = () => {
      clearInterval(timer);
      timer = null;
      const running = !paused && !holding && !document.hidden;
      live.setAttribute('aria-live', running ? 'off' : 'polite');
      if (running) timer = setInterval(() => show(current + 1), 6000);
    };
    const setPaused = (p) => {
      paused = p;
      pause.classList.toggle('is-paused', p);
      pause.setAttribute('aria-label', p ? 'Play messages' : 'Pause messages');
      schedule();
    };
    const hold = (h) => { holding = h; schedule(); };
    dots.forEach((d, n) => d.addEventListener('click', () => { show(n); schedule(); }));
    pause.addEventListener('click', () => setPaused(!paused));
    carousel.addEventListener('pointerenter', () => hold(true));
    carousel.addEventListener('pointerleave', () => hold(false));
    carousel.addEventListener('focusin', () => hold(true));
    carousel.addEventListener('focusout', (e) => { if (!carousel.contains(e.relatedTarget)) hold(false); });
    document.addEventListener('visibilitychange', schedule);
    carousel.querySelector('.hero-controls').hidden = false;
    setPaused(paused);
  }

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
