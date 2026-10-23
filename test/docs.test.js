'use strict';

// The documentation pages in website/docs are built from USERGUIDE.md (npm run docs) and committed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, slugify } = require('../scripts/build-docs');

const committed = path.join(__dirname, '..', 'website', 'docs');
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-docs-'));
const res = build(fresh);
const pages = res.pages;

test('the committed pages match USERGUIDE.md (run npm run docs after changing it)', () => {
  for (const name of [...pages, 'docs.css', 'docs.js']) {
    const want = fs.readFileSync(path.join(fresh, name), 'utf8');
    const have = fs.existsSync(path.join(committed, name)) ? fs.readFileSync(path.join(committed, name), 'utf8') : null;
    assert.ok(have === want, `website/docs/${name} is out of date: run npm run docs`);
  }
  for (const img of res.images) assert.ok(fs.existsSync(path.join(committed, 'img', path.basename(img))), `website/docs/img/${path.basename(img)} is missing`);
});

test('every page has the topics on the left, and links inside the docs lead to a page and section that exist', () => {
  const ids = new Map(pages.map((p) => [p, new Set([...fs.readFileSync(path.join(fresh, p), 'utf8').matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  for (const p of pages) {
    const html = fs.readFileSync(path.join(fresh, p), 'utf8');
    assert.match(html, /class="docs-topics"/, `${p} has the topic navigation`);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:|\.\.\/)/.test(href) || /\.(css|svg|png)(\?v=[0-9a-f]+)?$/.test(href)) continue; // stylesheets carry their version
      const [file, hash] = href.split('#');
      const target = file || p;
      assert.ok(ids.has(target), `${p} links to ${href}, which is not a docs page`);
      if (hash) assert.ok(ids.get(target).has(hash), `${p} links to ${href}, which has no such section`);
    }
  }
});

test('the site\'s pages link to the current version of each stylesheet and script (run npm run docs after changing one)', () => {
  const site = path.join(__dirname, '..', 'website');
  for (const page of ['index.html', 'sponsors.html']) {
    const html = fs.readFileSync(path.join(site, page), 'utf8');
    for (const [, name, v] of html.matchAll(/(?:href|src)="([\w-]+\.(?:css|js))(?:\?v=([0-9a-f]+))?"/g)) {
      const want = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(site, name))).digest('hex').slice(0, 10);
      assert.strictEqual(v, want, `${page} links to an old ${name}: run npm run docs`);
    }
  }
});

test('anchors are GitHub\'s, so links written for USERGUIDE.md keep working', () => {
  assert.strictEqual(slugify('Flows (request orchestration)'), 'flows-request-orchestration');
  assert.strictEqual(slugify('Instead of curl: test an endpoint and keep it'), 'instead-of-curl-test-an-endpoint-and-keep-it');
  assert.strictEqual(slugify('Spoofing Referer, Origin, User-Agent and other headers'), 'spoofing-referer-origin-user-agent-and-other-headers');
});
