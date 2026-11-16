#!/usr/bin/env node
/**
 * End-to-end check of removal experiments (`experiment --kind remove`) on the
 * fixture site (tests/fixtures/site/server.mjs), through the CLI, without
 * energy hardware:
 *
 *  - /lab/ticker   removed and stayed removed, while its timer kept firing:
 *                  applied, and the report says script work carried on
 *  - /spinner      a CSS animation stops with its element
 *  - /lab/remount  the page puts the component back: not applied, exit 2,
 *                  no difference reported
 *  - /big-list li  too broad: refused, nothing removed, stopped after one run
 *  - /table        removing the table takes its sort button: a failed check, and
 *                  the saving is marked not like-for-like
 *
 *  - remove-before-load on /lab/static: the archive never reaches the parser;
 *    on /lab/ensure the page's script creates it anyway: not applied
 *
 * Every energy figure reads "not measured": no energy hardware, so none.
 *
 * Usage: node tests/e2e/remove-e2e.mjs   (after npm run build and
 * npx playwright install firefox). Where Playwright's Firefox cannot be
 * installed, WEB_ENERGY_TEST_ENGINE=chromium runs the same checks in Chromium,
 * for structure only.
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
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=remove-e2e::${message.replace(/\n/g, '%0A')}`);
  }
};
const exec = (args) =>
  new Promise((resolve) => {
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });

const site = await startFixtureSite({ port: 8086 });
// The lab pages answer on any host; 127.0.0.1 needs no hosts-file entry.
const base = 'http://127.0.0.1:8086';

async function experiment(path, selector, extra = [], kind = 'remove') {
  const out = mkdtempSync(join(tmpdir(), 'remove-'));
  const r = await exec([
    'dist/cli/index.js', 'experiment', `${base}${path}`, '--kind', kind, '--selector', selector,
    '--runs', '2', '--warmups', '0', '--idle', '1500', '--settle', '500', '--headless', '--no-energy', '--out', out, ...extra,
  ]);
  const files = readdirSync(out);
  const json = files.find((f) => f.endsWith('.json'));
  const result = json ? JSON.parse(readFileSync(join(out, json), 'utf8')) : undefined;
  const html = files.find((f) => f.endsWith('.html'));
  return { ...r, result, x: result?.experiment, files, html: html ? readFileSync(join(out, html), 'utf8') : '' };
}

try {
  const ticker = await experiment('/lab/ticker', '[data-component-id="ticker"]', ['--assert-role', 'main']);
  if (ticker.status !== 0) console.log(ticker.out);
  check(ticker.status === 0 && ticker.x?.applied.ok === true, `the ticker was removed and stayed removed (${ticker.x?.applied.note})`);
  check(ticker.x?.removal?.variant.removed.every((n) => n === 1) && ticker.x?.removal?.baseline.removed.every((n) => n === 0), 'removed on the variant only, in every run');
  check(ticker.x?.removal?.activity.continued.some((c) => c.startsWith('timer callbacks')), `the report says the timer kept firing (${JSON.stringify(ticker.x?.removal?.activity)})`);
  check(ticker.x?.differences.length === 2 && ticker.x.differences.every((d) => d.verdict === 'not-measured' && d.energy === undefined), 'without energy hardware, both steps read "not measured", with no energy figure');
  check(ticker.x?.differences.find((d) => d.step === 'load')?.role === 'negative-control', 'the load step is a negative control');
  check(ticker.x?.likeForLike?.ok === false && /heading/.test(ticker.x.likeForLike.reasons.join(' ')), `removing the ticker took its heading, so a saving would not be like-for-like (${JSON.stringify(ticker.x?.likeForLike)})`);
  check(ticker.html.includes('id="removal-h"') && !/<script/i.test(ticker.html), 'the HTML report shows the removal, without scripts');
  check(ticker.files.some((f) => f.endsWith('.experiment.csv')), 'an experiment CSV was written');

  const spin = await experiment('/spinner', '[data-component-id="spinner"]');
  check(spin.x?.applied.ok === true && spin.x?.removal?.variant.activity?.runningAnimations[1] === 0 && spin.x?.removal?.baseline.activity?.runningAnimations[1] >= 1,
    `the spinner's CSS animation stopped with its element (${JSON.stringify([spin.x?.removal?.baseline.activity?.runningAnimations, spin.x?.removal?.variant.activity?.runningAnimations])})`);

  const remount = await experiment('/lab/remount', '[data-component-id="promo"]');
  check(remount.status === 2 && remount.x?.applied.ok === false && /put the component back/.test(remount.x.applied.note), `the component the page puts back is not counted as removed (${remount.x?.applied.note})`);
  check(remount.x?.differences.length === 0 && remount.x?.removal?.reinserted === true, 'no difference is reported from it');

  const broad = await experiment('/big-list', 'li');
  check(broad.status === 2 && /Removal refused/.test(broad.x?.applied.note ?? ''), `a selector matching 2,008 elements is refused (${broad.x?.applied.note})`);
  check((broad.result?.scenarios ?? []).filter((s) => s.scenario === 'variant').length <= 2 && broad.result?.warnings.some((w) => /Stopped after run/.test(w)), 'the experiment stopped after the refused run');

  const table = await experiment('/table', '[data-component-id="data-table"]', ['--assert-text', 'Sort by value']);
  check(table.x?.assertions.variant.length > 0 && table.x?.assertions.baseline.length === 0, `the variant failed the sort-button check the baseline passed (${JSON.stringify(table.x?.assertions)})`);
  check(table.x?.likeForLike?.ok === false, 'so the saving is marked not like-for-like');

  // Before the page is parsed: the archive never reaches the browser; both sides get the same snapshot.
  const pre = await experiment('/lab/static', '[data-component-id="archive"]', [], 'remove-before-load');
  if (pre.status !== 0) console.log(pre.out);
  check(pre.status === 0 && pre.x?.applied.ok === true && pre.x?.removal?.mode === 'pre-load', `remove-before-load removed the archive from the markup (${pre.x?.applied.note})`);
  check(pre.x?.differences.every((d) => d.role === 'attributable'), 'both load and idle are attributable before parsing');
  check(pre.x?.removal?.snapshot && pre.x.removal.snapshot.servedBytes[1] < pre.x.removal.snapshot.servedBytes[0], `the variant was served less markup (${JSON.stringify(pre.x?.removal?.snapshot)})`);
  const ensured = await experiment('/lab/ensure', '[data-component-id="notice"]', [], 'remove-before-load');
  check(ensured.status === 2 && /created the component themselves/.test(ensured.x?.applied.note ?? ''), `a component the page's script recreates is not counted as removed (${ensured.x?.applied.note})`);
} finally {
  await site.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll removal checks passed.');
