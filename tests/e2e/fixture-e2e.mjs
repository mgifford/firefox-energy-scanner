#!/usr/bin/env node
/**
 * End-to-end check of the component graph in Firefox, on the fixture site
 * (tests/fixtures/site/server.mjs): a shared navigation is one type with an
 * instance per page; a component unique to one page is found there; nested
 * components are linked and counted once; resources are placed by reach and
 * by the component that loads them; the graph validates; and with no energy
 * hardware, nothing claims a measured energy figure. With --trace, three
 * pages from different families are traced in Chromium and their findings
 * join the graph, still without an energy figure.
 *
 * Usage: node tests/e2e/fixture-e2e.mjs   (after npm run build and
 * npx playwright install firefox). CI maps www.site.test and thirdparty.test to 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from '../fixtures/site/server.mjs';
import { validateGraph } from '../../dist/model/schema.js';

const failures = [];
const annotate = (level, message) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=fixture-e2e::${message.replace(/\n/g, '%0A')}`);
};
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) {
    failures.push(message);
    annotate('error', message);
  }
};
const exec = (args) =>
  new Promise((resolve) => {
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 6 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });

const site = await startFixtureSite({ port: 8082 });
try {
  const out = mkdtempSync(join(tmpdir(), 'fixture-'));
  // --trace: three pages traced in Chromium after Firefox closes (needs a Chrome; GitHub's runners have one).
  const r = await exec(['dist/cli/index.js', 'crawl', `${site.url}/`, '--sample', '--max-pages', '20', '--headless', '--no-energy', '--trace', '--trace-pages', '3', '--trace-idle', '2000', '--out', out]);
  if (r.status !== 0) console.log(r.out);
  const files = readdirSync(out);
  const json = files.find((f) => f.endsWith('.json'));
  const result = json ? JSON.parse(readFileSync(join(out, json), 'utf8')) : null;
  const g = result?.graph;
  check(!!g, 'the crawl wrote a component graph');
  check(result?.schemaVersion === 2, `the result is schema version 2 (${result?.schemaVersion})`);
  check(!!g && validateGraph(g).length === 0, `the graph validates (${g ? validateGraph(g).slice(0, 2).join('; ') : 'none'})`);

  const types = (sig) => (g?.types ?? []).filter((t) => t.signature === sig);
  const inst = (sig) => (g?.instances ?? []).filter((i) => types(sig).some((t) => t.id === i.type));
  const pages = g?.pages.length ?? 0;
  annotate('notice', `graph: ${pages} pages, ${g?.types.length} types, ${g?.instances.length} instances, ${g?.resources.length} resources; types: ${(g?.types ?? []).map((t) => `${t.signature}:${t.pages}`).join(', ')}`);

  check(pages >= 10, `the sample covered the site (${pages} pages)`);
  check(types('component:site-nav').length === 1 && types('component:site-nav')[0].pages === pages && inst('component:site-nav').length === pages,
    `the shared navigation is one type with one instance per page (${types('component:site-nav').map((t) => `${t.pages} pages, ${t.instances} instances`)})`);
  const chart = inst('component:live-chart');
  check(chart.length === 1 && g.pages.find((p) => p.id === chart[0].page)?.url.endsWith('/articles/d'), 'the chart is unique to /articles/d');

  const card = inst('component:card')[0];
  const parent = card && g.instances.find((i) => i.id === card.parent);
  check(!!parent && types('component:card-list').some((t) => t.id === parent.type) && parent.own.nodes < parent.inclusiveNodes,
    'cards sit in their card list, which owns only its own markup');
  check(g.instances.every((i) => i.ownEstimated === false), 'Firefox recorded owned counts (none estimated)');

  const res = (key) => g.resources.find((x) => x.key === key);
  check(res('www.site.test/css/site.css')?.scope === 'site-wide', `the site stylesheet is site-wide (${res('www.site.test/css/site.css')?.scope})`);
  check((res('www.site.test/js/cards.js')?.loadedBy ?? []).length > 0, 'the cards script is loaded by the card list');
  check(res('thirdparty.test/widget')?.thirdParty === true, 'the embed is a third-party resource');
  check(g.findings.some((f) => f.kind === 'endless-animation'), 'Firefox saw an endless animation');
  check(g.findings.every((f) => f.energy.status === 'not-measured' && f.energy.measuredWorkloadDeltaMwh === null), 'no finding claims a measured energy figure');
  check(files.some((f) => f.endsWith('.resources.csv')), 'a resources CSV was written');

  // Tracing, through the crawl: one page per family first, attached to the result and the graph.
  const traced = (result?.traces ?? []).filter((t) => t.analysis);
  annotate('notice', `traces: ${(result?.traces ?? []).map((t) => `${t.url} ${t.analysis ? `${t.bytes} bytes` : t.skipped}`).join('; ')}`);
  check(traced.length === 3, `three pages were traced in Chromium (${traced.length}; ${(result?.traces ?? []).map((t) => t.skipped).filter(Boolean).join('; ') || (result?.warnings ?? []).filter((w) => /trac/i.test(w)).join('; ')})`);
  const fams = new Set(traced.map((t) => result.families?.pageFamily[t.url]));
  check(fams.size === Math.min(3, result?.families?.families.length ?? 0), `the traced pages come from different families (${fams.size})`);
  check(g?.sources.some((x) => x.id === 'chromium-trace'), 'the graph records Chromium tracing as a source');
  check(g.findings.filter((f) => f.kind.startsWith('trace:')).every((f) => f.evidenceClass === 'trace-supported' && f.energy.status === 'not-measured'),
    'trace findings are trace-supported and claim no energy');
  const html = readFileSync(join(out, files.find((f) => f.endsWith('.html'))), 'utf8');
  check(html.includes('id="traces-h"'), 'the report has a Chromium traces section');

  // Only HTML pages are measured: the sitemap's PDF, at an address with no
  // extension, is found from its Content-Type and skipped before Firefox visits it.
  const pdf = `${site.url}/files/document/annual-reportpdf`;
  check(!result.scenarios.some((s) => s.step === pdf), 'the PDF listed in the sitemap was not visited');
  check(result.sampling?.notHtml?.some((n) => n.url === pdf && n.contentType === 'application/pdf'), `the PDF is recorded as skipped, with its type (${JSON.stringify(result.sampling?.notHtml)})`);
  check(html.includes('was not an HTML page') || html.includes('were not HTML pages'), 'the report says what was skipped');

  // measure: a listed file is skipped once, before any warmup, not run as a download.
  const mout = mkdtempSync(join(tmpdir(), 'fixture-measure-'));
  await exec(['dist/cli/index.js', 'measure', `${site.url}/light`, pdf, '--runs', '1', '--warmups', '0', '--headless', '--no-energy', '--no-history', '--out', mout]);
  const mjson = readdirSync(mout).find((f) => f.endsWith('.json'));
  const mres = mjson ? JSON.parse(readFileSync(join(mout, mjson), 'utf8')) : null;
  check(!!mres && mres.scenarios.every((s) => s.step !== pdf) && mres.scenarios.some((s) => s.step.endsWith('/light')), 'measure skips the PDF and measures the page');
  check((mres?.warnings ?? []).some((w) => w.startsWith(pdf) && /Not an HTML page \(application\/pdf\)/.test(w)), 'measure says why the PDF was skipped');
} finally {
  await site.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fixture checks passed.');
