#!/usr/bin/env node
/**
 * End-to-end check with real Firefox: does a crawl follow a www redirect and
 * cover the site, and is a PDF in a list reported as "not a web page"?
 *
 * Serves a small site under two host names, site.test and www.site.test
 * (CI maps both to 127.0.0.1 in /etc/hosts). site.test redirects to
 * www.site.test, as france.fr does to www.france.fr. Pages link to each other
 * in every spelling a real site uses: relative, absolute www, bare-domain,
 * plus an external link and a PDF.
 *
 * Usage: node tests/e2e/crawl-e2e.mjs   (after npm run build and
 * npx playwright install firefox)
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8080;
const WWW = `http://www.site.test:${PORT}`;
const BARE = `http://site.test:${PORT}`;

const page = (title, links) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main><h1>${title}</h1><ul>${links.map((l) => `<li><a href="${l}">${l}</a></li>`).join('')}</ul></main></body></html>`;

const PAGES = {
  '/en/': page('Home', ['/en/about', `${WWW}/en/contact`, `${BARE}/en/about`, '/fr/', '/docs/report.pdf', 'https://example.org/']),
  '/en/about': page('About', ['/en/', '/en/team', `${BARE}/en/team/`]),
  '/en/contact': page('Contact', ['/en/', 'mailto:hello@site.test']),
  '/en/team': page('Team', ['/en/about']),
  '/fr/': page('Accueil', ['/en/']),
};

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const path = req.url.split('?')[0];
  // The bare domain always redirects to www, keeping the path.
  if (host === 'site.test') {
    res.writeHead(301, { Location: `${WWW}${path === '/' ? '/en/' : path}` });
    return res.end();
  }
  if (path === '/') {
    res.writeHead(302, { Location: '/en/' });
    return res.end();
  }
  if (path === '/docs/report.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="report.pdf"' });
    return res.end('%PDF-1.4\n% test\n');
  }
  const body = PAGES[path] ?? PAGES[path.replace(/\/$/, '')] ?? PAGES[`${path}/`];
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

function run(args, outDir) {
  const r = spawnSync('node', ['dist/cli/index.js', ...args, '--headless', '--no-energy', '--out', outDir], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  if (r.status !== 0) console.log(r.stdout, r.stderr);
  const file = readdirSync(outDir).find((f) => f.endsWith('.json'));
  return file ? JSON.parse(readFileSync(join(outDir, file), 'utf8')) : null;
}

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
try {
  // 1. Crawl from the bare domain, which redirects to www.
  const crawl = run(['crawl', `${BARE}/`, '--max-pages', '20'], mkdtempSync(join(tmpdir(), 'crawl-')));
  check(crawl !== null, 'crawl wrote a result');
  const pages = (crawl?.scenarios ?? []).filter((s) => s.valid).map((s) => s.url ?? s.step);
  const paths = pages.map((u) => new URL(u).pathname.replace(/\/$/, '') || '/').sort();
  console.log('     crawled:', pages.join(', '));
  check(pages.length >= 5, `crawl followed the redirect and covered the site (${pages.length} pages, want 5)`);
  for (const p of ['/en', '/en/about', '/en/contact', '/en/team', '/fr']) {
    check(paths.includes(p), `crawl reached ${p}`);
  }
  check(new Set(paths).size === paths.length, 'each page was measured once, whatever spelling linked to it');
  check(!pages.some((u) => u.includes('example.org')), 'crawl stayed on the site');
  check(!(crawl?.scenarios ?? []).some((s) => s.step.endsWith('.pdf')), 'crawl skipped the PDF link');

  // 2. A list that includes a PDF directly.
  const list = run(['measure', `${WWW}/en/`, `${WWW}/docs/report.pdf`, '--runs', '1', '--warmups', '0'],
    mkdtempSync(join(tmpdir(), 'list-')));
  const pdf = (list?.scenarios ?? []).find((s) => s.step.endsWith('.pdf'));
  check(!!pdf && pdf.valid === false && /^Not a web page/.test(pdf.warnings[0] ?? ''), 'a listed PDF is reported as not a web page');
  const home = (list?.scenarios ?? []).find((s) => s.step === `${WWW}/en/`);
  check(!!home && home.valid && home.network.transferBytes > 0, 'the page next to it was measured normally');
} finally {
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
