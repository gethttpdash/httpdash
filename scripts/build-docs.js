#!/usr/bin/env node
'use strict';

/*
 * Builds the documentation pages of httpdash.com from USERGUIDE.md: `npm run docs`.
 *
 * Every "## " topic becomes website/docs/<slug>.html, with the topics on the left (grouped, with a
 * filter) and the page's sections on the right ("### " headings, and paragraphs that are only bold
 * text, such as "**Running**"). website/docs/index.html lists the topics. Links between sections
 * point at the page that has them, screenshots are copied next to the pages, and links to other
 * files of the repository go to GitHub. The site has no build step, so the pages are committed;
 * test/docs.test.js fails when they are out of date with USERGUIDE.md.
 *
 * `node scripts/build-docs.js --out <dir>` writes somewhere else (the test uses it).
 */
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/gethttpdash/httpdash';
const SITE = 'https://httpdash.com';

// Topics in the left-hand navigation, by group (by slug); a topic not listed goes under "More".
const GROUPS = [
  ['Getting started', ['install-and-update', 'import-and-export-everything', 'keyboard-shortcuts', 'features-at-a-glance']],
  ['Sending and testing', ['auth-dependencies-auto-refresh-tokens', 'data-files-data-driven-runs', 'request-versions-and-spec-warnings', 'tags-and-search', 'streaming-responses-server-sent-events', 'websocket-requests', 'spoofing-referer-origin-user-agent-and-other-headers', 'script-sandbox']],
  ['Automation', ['flows-request-orchestration', 'command-line-runner-ci-and-schedulers', 'monitors', 'mock-server', 'ai-agents-openapi-and-mcp']],
  ['Services and networks', ['service-discovery-auto-create-environments', 'health-while-it-runs-profiling', 'where-a-request-went-on-the-network', 'tunnels-into-internal-networks', 'client-certificates-and-custom-cas']],
  ['Teams and security', ['team-sharing-through-git', 'app-lock-with-ldap-sign-in', 'secret-scan-and-audit-log']],
];

// Summaries for topics that open with a list rather than a sentence.
const SUMMARIES = {
  'features-at-a-glance': 'Everything HttpDash does, in one list: requests, responses, scripts, organisation, the runner, import and export, and the tools.',
};

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const slugify = (text) => String(text).trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (md) => String(md).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A short summary of a topic for cards and descriptions: its first paragraph that reads as a
 * sentence (not a list, table, code, heading or bold-only label), up to `max` characters.
 */
function excerpt(md, max = 150, slug = '') {
  if (SUMMARIES[slug]) return SUMMARIES[slug];
  const blocks = String(md).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const prose = blocks.filter((b) => !/^(#|[-*+] |\d+\. |\||```|!\[|>)/.test(b) && !/^\*\*[^*]+\*\*$/.test(b));
  const pick = prose[0] || '';
  if (!pick) return '';
  let text = plain(pick.split(/\n[-*+] /)[0]).replace(/:$/, '.');
  if (text.length > max) text = `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return text;
}

/** Splits the guide into its introduction and topics: [{ title, slug, md, sections: [{ title, id }] }]. */
function parseGuide(md) {
  const lines = md.split('\n');
  const intro = [];
  const topics = [];
  let current = null;
  let fence = false;
  for (const line of lines) {
    if (/^```/.test(line)) fence = !fence;
    const h2 = !fence && /^## (.+)$/.exec(line);
    if (h2) {
      current = { title: h2[1].trim(), slug: slugify(h2[1]), lines: [] };
      topics.push(current);
      continue;
    }
    if (/^# /.test(line) && !current) continue;
    (current ? current.lines : intro).push(line);
  }
  const kept = topics.filter((t) => t.slug !== 'contents');
  for (const t of kept) {
    t.md = t.lines.join('\n').trim();
    delete t.lines;
  }
  return { intro: intro.join('\n').trim(), topics: kept };
}

/** Where every heading anchor lives: id -> page file. */
function anchorMap(topics) {
  const map = new Map();
  for (const t of topics) {
    map.set(t.slug, `${t.slug}.html`);
    let fence = false;
    for (const line of t.md.split('\n')) {
      if (/^```/.test(line)) fence = !fence;
      const m = !fence && /^###+ (.+)$/.exec(line);
      if (m) map.set(slugify(m[1]), `${t.slug}.html#${slugify(m[1])}`);
    }
  }
  return map;
}

/** Renders a topic's Markdown, with ids on its headings, links fixed and screenshots collected. */
function renderTopic(t, anchors, images) {
  const sections = [];
  const used = new Set();
  const uniqueId = (base) => { let id = base || 'section'; for (let i = 2; used.has(id); i++) id = `${base}-${i}`; used.add(id); return id; };
  const marked = new Marked({ gfm: true });
  const fixHref = (href) => {
    if (!href) return href;
    if (href.startsWith('#')) return anchors.get(href.slice(1)) ? (anchors.get(href.slice(1)).startsWith(`${t.slug}.html#`) ? href : anchors.get(href.slice(1))) : href;
    const guide = /^USERGUIDE\.md(?:#(.*))?$/.exec(href);
    if (guide) return guide[1] ? anchors.get(guide[1]) || 'index.html' : 'index.html';
    if (/^[a-z]+:/i.test(href) || href.startsWith('//')) return href;
    return `${REPO}/blob/main/${href.replace(/^\.\//, '')}`;
  };
  marked.use({
    walkTokens(token) {
      // A paragraph that is only bold text ("**Running**") is a heading in all but name.
      if (token.type === 'paragraph' && token.tokens && token.tokens.length === 1 && token.tokens[0].type === 'strong') {
        token.type = 'heading';
        token.depth = 3;
        token.tokens = token.tokens[0].tokens;
        token.text = token.tokens.map((x) => x.raw).join('');
      }
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        const id = uniqueId(slugify(plain(text)));
        if (depth === 3) sections.push({ title: plain(text), id });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const to = fixHref(href);
        const external = /^https?:/.test(to) && !to.startsWith(SITE);
        return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${inner}</a>`;
      },
      image({ href, text }) {
        if (/^docs\/screenshots\//.test(href)) {
          images.add(href);
          return `<img src="img/${esc(path.basename(href))}" alt="${esc(text)}" loading="lazy">`;
        }
        return `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">`;
      },
    },
  });
  // Tables scroll on their own on narrow screens.
  const html = marked.parse(t.md).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, sections };
}

const head = ({ title, description, canonical, depth = 1 }) => {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#e8590c">
  <link rel="canonical" href="${canonical}">
  <link rel="icon" type="image/svg+xml" href="${up}assets/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="${up}assets/favicon-32.png">
  <link rel="apple-touch-icon" href="${up}assets/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="HttpDash">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${SITE}/assets/og.jpg">
  <link rel="stylesheet" href="${up}styles.css">
  <link rel="stylesheet" href="docs.css">
</head>`;
};

const siteHeader = `  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <div class="wrap nav-inner docs-nav-inner">
      <a class="brand" href="../index.html" aria-label="HttpDash home"><img src="../assets/logo.png" alt="" width="28" height="28"><span>HttpDash</span></a>
      <nav aria-label="Main">
        <ul class="nav-links">
          <li><a href="../index.html#features">Features</a></li>
          <li><a href="../index.html#automation">Automation</a></li>
          <li><a href="../index.html#cli">CLI</a></li>
          <li><a href="index.html" aria-current="page">Docs</a></li>
          <li><a href="../sponsors.html">Sponsors</a></li>
        </ul>
      </nav>
      <a class="btn btn-primary btn-sm nav-cta" href="../index.html#download">Download</a>
    </div>
  </header>`;

const siteFooter = `  <footer class="footer">
    <div class="wrap footer-inner">
      <a class="brand" href="../index.html"><img src="../assets/logo.png" alt="" width="22" height="22"><span>HttpDash</span></a>
      <nav aria-label="Footer">
        <a href="${REPO}">GitHub</a>
        <a href="${REPO}/releases">Releases</a>
        <a href="index.html">Documentation</a>
        <a href="../sponsors.html">Sponsors</a>
      </nav>
      <p class="footer-copy">© HttpDash</p>
    </div>
  </footer>
  <script src="docs.js"></script>`;

/** The left-hand navigation: groups of topics, the current one marked, with a filter. */
function topicNav(groups, currentSlug) {
  return `<nav class="docs-topics" aria-label="Topics">
        <details class="docs-topics-toggle" open>
          <summary>Topics</summary>
          <input class="docs-filter" type="search" placeholder="Filter topics" aria-label="Filter topics">
          <a class="docs-home${currentSlug ? '' : ' current'}" href="index.html"${currentSlug ? '' : ' aria-current="page"'}>Overview</a>
${groups.map(([name, topics]) => `          <p class="docs-group">${esc(name)}</p>
          <ul>
${topics.map((t) => `            <li><a href="${t.slug}.html" data-search="${esc(`${t.title} ${t.sections.map((s) => s.title).join(' ')}`.toLowerCase())}"${t.slug === currentSlug ? ' class="current" aria-current="page"' : ''}>${esc(t.title)}</a></li>`).join('\n')}
          </ul>`).join('\n')}
          <p class="docs-none" hidden>No topic matches.</p>
        </details>
      </nav>`;
}

function build(outDir) {
  const guide = fs.readFileSync(path.join(ROOT, 'USERGUIDE.md'), 'utf8');
  const { intro, topics } = parseGuide(guide);
  const anchors = anchorMap(topics);
  const images = new Set();
  for (const t of topics) Object.assign(t, renderTopic(t, anchors, images));

  // Topics in their groups, in the order of the groups; the rest under "More".
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const placed = new Set();
  const groups = GROUPS.map(([name, slugs]) => [name, slugs.filter((s) => bySlug.has(s)).map((s) => { placed.add(s); return bySlug.get(s); })]).filter(([, list]) => list.length);
  const rest = topics.filter((t) => !placed.has(t.slug));
  if (rest.length) groups.push(['More', rest]);
  const ordered = groups.flatMap(([, list]) => list);

  fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });
  const files = {};
  ordered.forEach((t, i) => {
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    const group = groups.find(([, list]) => list.includes(t))[0];
    const description = excerpt(t.md, 160, t.slug);
    files[`${t.slug}.html`] = `${head({ title: `${t.title} · HttpDash docs`, description, canonical: `${SITE}/docs/${t.slug}.html` })}
<body class="docs">
${siteHeader}

  <div class="wrap docs-layout">
    <aside class="docs-left">
      ${topicNav(groups, t.slug)}
    </aside>

    <main id="main" class="docs-main">
      <p class="docs-crumbs"><a href="index.html">Docs</a> <span aria-hidden="true">›</span> ${esc(group)}</p>
      <article class="docs-article">
        <h1>${esc(t.title)}</h1>
${t.html}
      </article>
      <nav class="docs-pager" aria-label="Previous and next topic">
        ${prev ? `<a class="docs-prev" href="${prev.slug}.html"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="docs-next" href="${next.slug}.html"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
      </nav>
      <p class="docs-edit"><a href="${REPO}/edit/main/USERGUIDE.md">Edit this page on GitHub</a></p>
    </main>

    <aside class="docs-right">
${t.sections.length ? `      <nav class="docs-toc" aria-label="On this page">
        <p class="docs-toc-title">On this page</p>
        <ul>
${t.sections.map((s) => `          <li><a href="#${s.id}">${esc(s.title)}</a></li>`).join('\n')}
        </ul>
        <a class="docs-top" href="#main">Back to top</a>
      </nav>` : ''}
    </aside>
  </div>

${siteFooter}
</body>
</html>
`;
  });

  // The overview: the guide's introduction and every topic, by group.
  const introHtml = renderTopic({ slug: 'index', md: intro }, anchors, images).html;
  files['index.html'] = `${head({ title: 'Documentation · HttpDash', description: 'How every part of HttpDash works: sending and testing requests, flows, the command-line runner, service discovery, AI agents, team sharing and security.', canonical: `${SITE}/docs/` })}
<body class="docs">
${siteHeader}

  <div class="wrap docs-layout docs-layout-index">
    <aside class="docs-left">
      ${topicNav(groups, null)}
    </aside>

    <main id="main" class="docs-main">
      <article class="docs-article">
        <h1>HttpDash documentation</h1>
        <div class="docs-intro">${introHtml}</div>
${groups.map(([name, list]) => `        <section class="docs-overview-group">
          <h2 id="${slugify(name)}">${esc(name)}</h2>
          <ul class="docs-cards">
${list.map((t) => `            <li><a href="${t.slug}.html"><strong>${esc(t.title)}</strong><span>${esc(excerpt(t.md, 140, t.slug))}</span></a></li>`).join('\n')}
          </ul>
        </section>`).join('\n')}
      </article>
    </main>

    <aside class="docs-right">
      <nav class="docs-toc" aria-label="On this page">
        <p class="docs-toc-title">On this page</p>
        <ul>
${groups.map(([name]) => `          <li><a href="#${slugify(name)}">${esc(name)}</a></li>`).join('\n')}
        </ul>
      </nav>
    </aside>
  </div>

${siteFooter}
</body>
</html>
`;

  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), content);
  for (const src of images) fs.copyFileSync(path.join(ROOT, src), path.join(outDir, 'img', path.basename(src)));
  for (const asset of ['docs.css', 'docs.js']) fs.copyFileSync(path.join(__dirname, 'docs', asset), path.join(outDir, asset));
  return { pages: Object.keys(files), images: [...images], anchors };
}

/** Lists the docs pages in website/sitemap.xml, replacing the ones listed before. */
function updateSitemap(pages) {
  const file = path.join(ROOT, 'website', 'sitemap.xml');
  const xml = fs.readFileSync(file, 'utf8').replace(/\s*<url>\s*<loc>https:\/\/httpdash\.com\/docs\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');
  const entries = pages.map((p) => `  <url>\n    <loc>${SITE}/docs/${p === 'index.html' ? '' : p}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${p === 'index.html' ? '0.8' : '0.6'}</priority>\n  </url>`).join('\n');
  fs.writeFileSync(file, xml.replace(/\s*<\/urlset>\s*$/, `\n${entries}\n</urlset>\n`));
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i !== -1 ? path.resolve(process.argv[i + 1]) : path.join(ROOT, 'website', 'docs');
  const res = build(out);
  if (i === -1) updateSitemap(['index.html', ...res.pages.filter((p) => p !== 'index.html')]);
  console.log(`Built ${res.pages.length} pages and copied ${res.images.length} screenshots into ${path.relative(ROOT, out) || out}`);
}

module.exports = { build, parseGuide, slugify };
