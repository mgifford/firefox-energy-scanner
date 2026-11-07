#!/usr/bin/env node
/**
 * End-to-end check with real Firefox: does a crawl follow a www redirect and
 * cover the site, does a --sample come from the sitemap (through that same
 * redirect, without stylesheets), is a PDF in a list reported as "not a web
 * page", and does --public-only keep the browser away from local addresses?
 *
 * Serves a small site under two host names, site.test and www.site.test
 * (CI maps both to 127.0.0.1 in /etc/hosts). site.test redirects to
 * www.site.test, as france.fr does to www.france.fr. Pages link to each other
 * in every spelling a real site uses: relative, absolute www, bare-domain,
 * plus an external link and a PDF.
 *
 * CI also maps looks-public.example.com to 127.0.0.1, the way DDEV's public
 * *.ddev.site names point at the local machine: --public-only must refuse it
 * after resolving it, without the site ever seeing a request.
 *
 * Usage: node tests/e2e/crawl-e2e.mjs   (after npm run build and
 * npx playwright install firefox)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8080;
const WWW = `http://www.site.test:${PORT}`;
const BARE = `http://site.test:${PORT}`;

// Pages are built like a small Drupal site, so page families have something
// to group: basic pages, and news articles with their own script.
const page = (title, links, type = 'page') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<script src="/js/site.js"></script>${type === 'article' ? '<script src="/js/article.js"></script>' : ''}</head>` +
  `<body class="path-node page-node-type-${type}">` +
  `<header class="site-header"><nav aria-label="Main"><ul><li><a href="/en/">Home</a></li><li><a href="/en/about">About</a></li></ul></nav></header>` +
  `<main><article class="node node--type-${type} node--view-mode-full"><h1>${title}</h1>` +
  (type === 'article' ? `<div class="paragraph paragraph--type--text">${'<p>Story text.</p>'.repeat(12)}</div>` : '') +
  `<ul>${links.map((l) => `<li><a href="${l}">${l}</a></li>`).join('')}</ul></article></main>` +
  `<footer><p>Site footer</p></footer></body></html>`;

const PAGES = {
  '/en/': page('Home', ['/en/about', `${WWW}/en/contact`, `${BARE}/en/about`, '/fr/', '/docs/report.pdf', 'https://example.org/']),
  '/en/about': page('About', ['/en/', '/en/team', `${BARE}/en/team/`]),
  '/en/contact': page('Contact', ['/en/', 'mailto:hello@site.test']),
  '/en/team': page('Team', ['/en/about']),
  '/fr/': page('Accueil', ['/en/']),
  // Linked from nowhere: only the sitemap names it.
  '/en/hidden': page('Hidden', ['/en/']),
  // Only the sitemap names these too: one template, three pages.
  '/en/news/budget': page('Budget news', ['/en/'], 'article'),
  '/en/news/office': page('Office news', ['/en/'], 'article'),
  '/en/news/award': page('Award news', ['/en/'], 'article'),
};

// Lists the hidden page, a stylesheet and another site, as real sitemaps do.
const SITEMAP =
  '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  ['/en/', '/en/about', '/en/contact', '/en/hidden', '/fr/', '/en/news/budget', '/en/news/office', '/en/news/award', '/assets/theme.min.css']
    .map((p) => `<url><loc>${WWW}${p}</loc></url>`)
    .join('') +
  '<url><loc>https://example.org/elsewhere</loc></url></urlset>';

const hostsSeen = new Set();
const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  hostsSeen.add(host);
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
  if (path === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(SITEMAP);
  }
  if (path.startsWith('/js/')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.loaded = (window.loaded || 0) + 1;`);
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
// In GitHub Actions, also emit annotations: they show on the pull request and
// can be read through the API, unlike the raw log.
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=crawl-e2e::${message.replace(/\n/g, '%0A')}`);
};
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) {
    failures.push(message);
    annotate('error', message);
  }
};

// Asynchronous on purpose: the test site is served by this same process, so
// a blocking spawnSync would stop it answering while the scanner runs.
function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function run(args, outDir) {
  const r = await exec('node', ['dist/cli/index.js', ...args, '--headless', '--no-energy', '--out', outDir]);
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    annotate('error', `${args[0]} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-800)}`);
  }
  const file = readdirSync(outDir).find((f) => f.endsWith('.json'));
  return file ? JSON.parse(readFileSync(join(outDir, file), 'utf8')) : null;
}

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
try {
  // 1. Crawl from the bare domain, which redirects to www.
  // A listed page that nothing links to (--also) must be measured too.
  const crawl = await run(['crawl', `${BARE}/`, '--max-pages', '20', '--also', `${WWW}/en/hidden`], mkdtempSync(join(tmpdir(), 'crawl-')));
  check(crawl !== null, 'crawl wrote a result');
  const pages = (crawl?.scenarios ?? []).filter((s) => s.valid).map((s) => s.url ?? s.step);
  const paths = pages.map((u) => new URL(u).pathname.replace(/\/$/, '') || '/').sort();
  console.log('     crawled:', pages.join(', '));
  annotate('notice', `crawled ${pages.length}: ${pages.join(', ')} | all steps: ${(crawl?.scenarios ?? []).map((s) => `${s.step}${s.valid ? '' : ' (FAILED: ' + (s.warnings[0] ?? '') + ')'}`).join(', ')}`);
  check(pages.length >= 5, `crawl followed the redirect and covered the site (${pages.length} pages, want 5)`);
  for (const p of ['/en', '/en/about', '/en/contact', '/en/team', '/fr']) {
    check(paths.includes(p), `crawl reached ${p}`);
  }
  check(new Set(paths).size === paths.length, 'each page was measured once, whatever spelling linked to it');
  check(paths.includes('/en/hidden'), 'the crawl measured a listed page that nothing links to');
  check(crawl?.sampling?.requested === 1, `the result records the listed page (${JSON.stringify(crawl?.sampling)})`);
  check(!pages.some((u) => u.includes('example.org')), 'crawl stayed on the site');
  check(!(crawl?.scenarios ?? []).some((s) => s.step.endsWith('.pdf')), 'crawl skipped the PDF link');

  // 2. A list that includes a PDF directly: skipped before Firefox visits it,
  // and still reported, with its type.
  const list = await run(['measure', `${WWW}/en/`, `${WWW}/docs/report.pdf`, '--runs', '1', '--warmups', '0'],
    mkdtempSync(join(tmpdir(), 'list-')));
  check(!(list?.scenarios ?? []).some((s) => s.step.endsWith('.pdf')), 'a listed PDF is not visited');
  check((list?.notHtml ?? []).some((n) => n.url === `${WWW}/docs/report.pdf` && n.contentType === '.pdf file'), `a listed PDF is reported as not an HTML page (${JSON.stringify(list?.notHtml)})`);
  check((list?.warnings ?? []).some((w) => w.startsWith(`${WWW}/docs/report.pdf: Not an HTML page`)), 'the result says why the PDF was skipped');
  const home = (list?.scenarios ?? []).find((s) => s.step === `${WWW}/en/`);
  check(!!home && home.valid && home.network.transferBytes > 0, 'the page next to it was measured normally');

  // 3. A sample from the sitemap, as a hosted single-URL scan takes one. The
  // start is the bare domain, which redirects to www, as canada.ca does.
  const sampled = await run(['crawl', `${BARE}/`, '--sample', '--max-pages', '20'], mkdtempSync(join(tmpdir(), 'sample-')));
  const samplePaths = (sampled?.scenarios ?? []).filter((s) => s.valid).map((s) => new URL(s.url ?? s.step).pathname);
  annotate('notice', `sample: ${JSON.stringify(sampled?.sampling)} | ${samplePaths.join(', ')}`);
  check(sampled?.sampling?.method === 'sitemap', `the sample came from the sitemap (${JSON.stringify(sampled?.sampling)})`);
  check(samplePaths.includes('/en/hidden'), 'the sample reached a page only the sitemap names');
  check(!samplePaths.some((p) => p.endsWith('.css')), 'the sample skipped the stylesheet the sitemap lists');
  check(!(sampled?.scenarios ?? []).some((s) => s.step.includes('example.org')), 'the sample stayed on the site');

  // Page structure, recorded in Firefox, and the families built from it.
  const about = (sampled?.scenarios ?? []).find((s) => s.valid && /\/en\/about$/.test(s.url ?? ''));
  const structure = about?.anatomy?.structure;
  check(['banner', 'navigation', 'main', 'contentinfo'].every((l) => structure?.landmarks?.includes(l)),
    `page structure records the landmarks (${JSON.stringify(structure?.landmarks)})`);
  check(!!structure?.components?.some((c) => c.signature === 'drupal-node:page:full') && structure?.drupal?.pageTemplate === 'page-node-type-page',
    `page structure names the Drupal component and template (${JSON.stringify(structure?.components?.slice(0, 4))})`);
  const fam = sampled?.families;
  const familyOf = (p) => fam?.pageFamily?.[`${WWW}${p}`];
  annotate('notice', `families: ${JSON.stringify(fam?.families?.map((f) => [f.label, f.pages.length]))}`);
  check(!!fam && fam.families.length >= 2, `the sample was grouped into page families (${fam?.families?.length ?? 0})`);
  check(!!familyOf('/en/news/budget') && familyOf('/en/news/budget') === familyOf('/en/news/office') && familyOf('/en/news/office') === familyOf('/en/news/award'),
    'the three news articles are one family');
  check(familyOf('/en/news/budget') !== familyOf('/en/about'), 'articles and basic pages are different families');
  check(Object.values(sampled?.sampling?.reasons ?? {}).includes('random'), 'the result says why each page was picked');
  // Key pages, found from the start page, come with the sample and count within the page limit.
  check((sampled?.sampling?.keyPages ?? []).some((k) => k.kind === 'contact' && k.url.endsWith('/en/contact')), `the crawl added the contact page as a key page (${JSON.stringify(sampled?.sampling?.keyPages)})`);
  check(sampled?.sampling?.reasons?.[`${WWW}/en/contact`] === 'key-page', 'the result says the contact page is a key page');
  check((sampled?.sampling?.picked ?? 99) <= 20, `key pages count within --max-pages (${sampled?.sampling?.picked} of 20)`);

  // 3b. An adaptive sample: one page from each URL section before any second
  // one, and the lone /fr/ page kept as a rare section. Started at /en/ so the
  // start page is not also a sitemap pick. Without key pages, which take
  // slots from the page limit: this checks the sampler's spread alone.
  const adaptive = await run(['crawl', `${WWW}/en/`, '--adaptive', '--max-pages', '5', '--no-key-pages'], mkdtempSync(join(tmpdir(), 'adaptive-')));
  const sections = (adaptive?.sampling?.strata ?? []).filter((s) => s.picked > 0).map((s) => s.section).sort();
  annotate('notice', `adaptive: ${JSON.stringify(adaptive?.sampling?.strata)}`);
  check(adaptive?.sampling?.method === 'adaptive', `the adaptive sample came from the sitemap (${adaptive?.sampling?.method})`);
  check(JSON.stringify(sections) === JSON.stringify(['/', '/en', '/en/news']), `the adaptive sample covered every URL section (${sections.join(', ')})`);
  check(adaptive?.sampling?.reasons?.[`${WWW}/fr`] === 'rare-section', `the lone /fr/ page was kept as a rare section (${JSON.stringify(adaptive?.sampling?.reasons)})`);

  // 4. Public-only mode, as hosted scans run: local names and addresses are
  // refused, by name or after resolving, and a public site still works.
  hostsSeen.clear();
  const local = [
    `${WWW}/en/`, // .test: refused by name
    `http://looks-public.example.com:${PORT}/en/`, // resolves to 127.0.0.1
    `http://mysite.ddev.site:${PORT}/`, // DDEV
    'https://mysite.ddev.site/', // DDEV over HTTPS: refused at CONNECT
    `http://127.0.0.1:${PORT}/en/`,
    `http://[::1]:${PORT}/en/`,
  ];
  const guarded = await run(['measure', ...local, 'https://example.com/', '--runs', '1', '--warmups', '0', '--public-only'],
    mkdtempSync(join(tmpdir(), 'guard-')));
  check(guarded?.configuration?.network?.public_only === true, 'the result records that the guard was on');
  for (const url of local) {
    const s = (guarded?.scenarios ?? []).find((x) => x.step === url);
    check(!!s && s.valid === false && /^Blocked: /.test(s.warnings[0] ?? ''),
      `public-only refused ${url} (${s?.warnings[0] ?? 'no step'})`);
  }
  check(hostsSeen.size === 0, `the local site received no request in public-only mode (saw: ${[...hostsSeen].join(', ') || 'none'})`);
  const pub = (guarded?.scenarios ?? []).find((x) => x.step === 'https://example.com/');
  check(!!pub && pub.valid && pub.network.transferBytes > 0,
    `public-only still measured a public HTTPS site (${pub?.warnings[0] ?? (pub ? 'ok' : 'no step')})`);
} finally {
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
