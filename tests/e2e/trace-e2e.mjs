#!/usr/bin/env node
/**
 * End-to-end check of Chromium tracing on the fixture site
 * (tests/fixtures/site/server.mjs), through `web-energy trace`: each behaviour
 * the site is built to show is found in the trace and named by its source.
 *
 *  - /compute       a 300 ms long task during load, inside compute.js
 *  - /articles/d    animation frames all through the idle window, requested from chart.js
 *  - /spinner       a CSS animation still running while idle
 *  - /embed         a cross-site iframe working in its own process, from widget.js
 *  - /tiny-work     a timer that fires once in the window: negligible, as built
 *  - /nope          a 404: not analysed, and says so
 *
 * Also: with --public-only, the network guard refuses the local site and no
 * trace is analysed. No energy is measured: tracing records main-thread time.
 *
 * Usage: node tests/e2e/trace-e2e.mjs  (after npm run build; needs Chrome or a
 * Playwright Chromium). CI maps www.site.test and thirdparty.test to 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from '../fixtures/site/server.mjs';

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) {
    failures.push(message);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=trace-e2e::${message.replace(/\n/g, '%0A')}`);
  }
};
const exec = (args) =>
  new Promise((resolve) => {
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 4 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
const records = (dir) => {
  const f = readdirSync(dir).find((x) => x.startsWith('trace-') && x.endsWith('.json'));
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')).records : [];
};

const site = await startFixtureSite({ port: 8084 });
try {
  const out = mkdtempSync(join(tmpdir(), 'trace-'));
  const paths = ['/compute', '/articles/d', '/spinner', '/embed', '/tiny-work', '/nope'];
  const r = await exec(['dist/cli/index.js', 'trace', ...paths.map((p) => `${site.url}${p}`), '--trace-idle', '3000', '--out', out]);
  if (r.status !== 0) console.log(r.out);
  const recs = records(out);
  const at = (p) => recs.find((x) => x.url === `${site.url}${p}`);
  check(recs.length === paths.length, `every page has a record (${recs.length})`);

  const compute = at('/compute')?.analysis;
  const task = compute?.load.longTasks[0];
  check(!!task && task.durationMs >= 250 && task.urls.some((u) => u.endsWith('/js/compute.js')), `the 300 ms loop is a long task in compute.js (${JSON.stringify(task)})`);

  const chart = at('/articles/d')?.analysis?.idle?.animationFrames;
  check(!!chart && chart.perSecond >= 20 && chart.sources[0]?.url.endsWith('/js/chart.js'), `the chart requests animation frames all through idle, from chart.js (${chart?.perSecond}/s, ${chart?.sources[0]?.url})`);

  const spin = at('/spinner')?.analysis?.idle?.animations ?? [];
  check(spin.length >= 1 && spin.every((a) => a.path), `the spinner's animation runs while idle, on a resolved element (${JSON.stringify(spin)})`);

  const frame = (at('/embed')?.analysis?.frames ?? []).find((f) => f.url.includes('thirdparty.test'));
  check(!!frame && (frame.idle?.timers.fired ?? 0) >= 2 && frame.idle.timers.sources[0]?.url.endsWith('/widget.js'), `the third-party iframe's timer is named, in its own process (${JSON.stringify(frame?.idle?.timers)})`);
  check(!(at('/embed')?.analysis?.load.requests ?? []).some((q) => q.url.includes('thirdparty.test/widget.js')), "the iframe's requests are not counted as the page's");

  const tiny = at('/tiny-work')?.analysis?.idle;
  check(!!tiny && tiny.timers.fired <= 2 && tiny.mainThread.busyMs < 50, `the tiny timer does negligible work (${tiny?.timers.fired} callbacks, ${tiny?.mainThread.busyMs} ms busy)`);

  check(at('/nope')?.skipped === 'The page answered HTTP 404.', `a 404 is not analysed, and says why (${at('/nope')?.skipped})`);
  check(recs.filter((x) => x.analysis).every((x) => x.browser.startsWith('Chromium') && x.bytes > 0 && x.bytes < 40e6), 'each trace names its browser and stays within budget');

  // The network guard: a local address is refused, never traced.
  const guarded = mkdtempSync(join(tmpdir(), 'trace-guard-'));
  await exec(['dist/cli/index.js', 'trace', `${site.url}/compute`, '--public-only', '--trace-idle', '1000', '--out', guarded]);
  const g = records(guarded)[0];
  check(!!g && !g.analysis && /network guard refused/.test(g.skipped ?? ''), `with --public-only, the local site is refused and not analysed (${g?.skipped})`);
} finally {
  await site.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll trace checks passed.');
