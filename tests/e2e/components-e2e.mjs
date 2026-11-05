#!/usr/bin/env node
/**
 * End-to-end check of the component inventory across two browsers: Firefox
 * records each page's components and their DevTools node paths, Lighthouse
 * audits the heaviest page in Chrome, and its element findings must land on
 * the component they fall in. That only works if both browsers number the
 * same DOM the same way, which a unit test cannot show.
 *
 * The site: three pages built alike, each with an annotated carousel holding
 * an endless animation of `width` (Chrome cannot composite it) and an image
 * without width and height, inside a Drupal-style view of teasers.
 *
 * Usage: node tests/e2e/components-e2e.mjs   (after a full `npm ci`, npm run
 * build and npx playwright install firefox; Chrome must be installed for
 * Lighthouse, as it is on GitHub's Ubuntu runners). CI maps www.site.test to
 * 127.0.0.1.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8081;
const SITE = `http://www.site.test:${PORT}`;

const teasers = (n) =>
  Array.from({ length: n }, (_, i) =>
    `<article class="node node--type-article node--view-mode-teaser"><h2><a href="/news/${i}">Story ${i}</a></h2><p>Summary ${i}.</p></article>`,
  ).join('');

const page = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>.pulse{height:12px;background:#c00;animation:pulse 1.5s ease-in-out infinite alternate}@keyframes pulse{from{width:40px}to{width:240px}}</style>
<script src="/js/site.js"></script></head>
<body class="path-frontpage">
<header class="site-header"><nav aria-label="Main"><ul><li><a href="/">Home</a></li><li><a href="/a">A</a></li></ul></nav></header>
<main>
<div class="carousel" data-component-id="demo:carousel" aria-label="Featured"><div class="pulse"></div><img src="/img/hero.svg" alt="Hero"></div>
<section class="view view-id-frontpage" aria-label="Latest news">${teasers(30)}</section>
</main>
<footer><p>Footer</p></footer></body></html>`;

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/a', '/b'].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`);
  }
  if (path === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nAllow: /\n');
  }
  if (path.startsWith('/img/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#39c"/></svg>');
  }
  if (path.startsWith('/js/')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end('window.siteLoaded = true;');
  }
  if (['/', '/a', '/b'].includes(path)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page(path === '/' ? 'Home' : `Page ${path.slice(1)}`));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const failures = [];
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=components-e2e::${message.replace(/\n/g, '%0A')}`);
};
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) {
    failures.push(message);
    annotate('error', message);
  }
};

function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 8 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
try {
  const out = mkdtempSync(join(tmpdir(), 'components-'));
  const r = await exec('node', [
    'dist/cli/index.js', 'crawl', `${SITE}/`, '--sample', '--max-pages', '3',
    '--lighthouse', '--lighthouse-top', '1', '--lighthouse-runs', '1',
    '--headless', '--no-energy', '--out', out,
  ]);
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    annotate('error', `crawl exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  const files = readdirSync(out);
  const json = files.find((f) => f.endsWith('.json'));
  const result = json ? JSON.parse(readFileSync(join(out, json), 'utf8')) : null;
  check(!!result, 'the crawl wrote a result');

  const pages = (result?.scenarios ?? []).filter((s) => s.valid);
  const instances = pages[0]?.anatomy?.structure?.instances ?? [];
  const carouselAt = instances.find((i) => i.signature === 'component:demo:carousel');
  check(!!carouselAt && /^1,HTML,1,BODY,/.test(carouselAt.nodePath), `Firefox recorded the carousel and its node path (${carouselAt?.nodePath})`);
  check(!!carouselAt?.animations?.infinite, `Firefox saw the carousel's endless animation (${JSON.stringify(carouselAt?.animations)})`);

  const inv = result?.components;
  const carousel = inv?.components?.find((c) => c.signature === 'component:demo:carousel');
  check(carousel?.pages === 3 && carousel?.confidence === 'high', `the carousel recurs on all three pages (${carousel?.pages})`);
  check(files.some((f) => f.endsWith('.components.csv')), 'a components CSV was written');

  const lh = result?.lighthouse?.results?.[0];
  annotate('notice', `lighthouse: ${lh?.error ?? 'ok'} | evidence: ${JSON.stringify(lh?.evidence?.nodes?.map((n) => [n.audit, n.path]))} | carousel: ${JSON.stringify(carousel?.evidence)}`);
  check(!!lh && !lh.error, `Lighthouse ran in Chrome (${lh?.error ?? 'ok'})`);
  check(!!carousel?.evidence?.some((e) => e.matchedBy === 'node-path' && ['non-composited-animations', 'unsized-images'].includes(e.audit)),
    'a Lighthouse element finding from Chrome landed on the carousel recorded in Firefox, by node path');
  check(!(carousel?.evidence ?? []).some((e) => /joule|mwh/i.test(JSON.stringify(e))), 'no evidence carries an energy unit');
} finally {
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll component checks passed.');
