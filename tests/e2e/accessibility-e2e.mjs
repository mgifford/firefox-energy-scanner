#!/usr/bin/env node
/**
 * End-to-end check of the optional Open Scans accessibility join, on a stored
 * fixture result. No browser and no Open Scans scan.
 *
 * Usage: node tests/e2e/accessibility-e2e.mjs   (after npm run build)
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAccessibilityJoin } from '../../dist/model/accessibility-join.js';

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};
const exec = (args) =>
  new Promise((resolve) => {
    const child = spawn('node', ['dist/cli/index.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });

const dir = mkdtempSync(join(tmpdir(), 'a11y-e2e-'));
const plain = join(dir, 'plain.json');
const joined = join(dir, 'joined.json');
copyFileSync('tests/fixtures/fixture-site-result.json', plain);
copyFileSync('tests/fixtures/fixture-site-result.json', joined);

const before = await exec(['report', plain]);
check(before.status === 0, `report without a context still works (${before.status})`);
check(!existsSync(join(dir, 'plain.accessibility-context.json')), 'no sidecar is written without the option');
check(!readFileSync(join(dir, 'plain.html'), 'utf8').includes('Related accessibility evidence'), 'no accessibility section appears without the option');

const after = await exec(['report', joined, '--accessibility-context', 'tests/fixtures/accessibility/context.json']);
check(after.status === 0, `report with a context succeeds (${after.status})`);
const sidecarPath = join(dir, 'joined.accessibility-context.json');
check(existsSync(sidecarPath), 'a sidecar join artifact is written');
if (existsSync(sidecarPath)) {
  const join = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  check(validateAccessibilityJoin(join).length === 0, 'the sidecar validates against fes-accessibility-join/1');
  check(join.schema === 'fes-accessibility-join/1', 'the sidecar names its schema');
  check(join.matches.some((m) => m.component?.signature === 'component:live-chart'), 'the exact CSS selector matched the chart instance');
  check(join.matches.some((m) => m.match.selectorType === 'xpath' && !m.component), 'an XPath selector stays page-level');
  check(join.unmatched.some((m) => m.match.reason === 'page-not-in-scan'), 'an unmatched page is preserved');
}
const html = readFileSync(join(dir, 'joined.html'), 'utf8');
check(html.includes('id="a11y-h"') && html.includes('Related accessibility evidence'), 'the HTML report has the accessibility section');
check(html.includes('not an energy finding and not a WCAG conformance claim'), 'the report states the evidence boundary');
check(html.includes('<caption>Accessibility observations matched to a measured page</caption>'), 'the report uses an accessible table');
check(!/<script|<img\s/i.test(html) && html.includes('&lt;script&gt;'), 'context text is escaped');
const stored = JSON.parse(readFileSync(joined, 'utf8'));
check(!('accessibilityContext' in stored), 'the measured result is not rewritten; the sidecar is the artifact');

const badResult = join(dir, 'bad-result.json');
copyFileSync('tests/fixtures/fixture-site-result.json', badResult);
const badContext = join(dir, 'bad-context.json');
writeFileSync(badContext, '{"schema":"not-the-open-scans-schema","observations":[]}');
const rejected = await exec(['report', badResult, '--accessibility-context', badContext]);
check(rejected.status === 1 && /Invalid Open Scans accessibility context/.test(rejected.out), 'a malformed context is rejected clearly');
check(!existsSync(join(dir, 'bad-result.accessibility-context.json')), 'a rejected context writes no sidecar');

if (failures.length) {
  console.error(`\n${failures.length} accessibility join check(s) failed.`);
  process.exit(1);
}
console.log('\nAll accessibility join checks passed.');
