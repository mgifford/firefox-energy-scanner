#!/usr/bin/env node
/**
 * The bounded candidate queue on a stored fixture result: no browser, no
 * experiment, no energy. Usage: node tests/e2e/queue-e2e.mjs (after npm run build).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCandidateQueue } from '../../dist/model/candidate-queue.js';
import { createHash } from 'node:crypto';

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
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'queue-e2e-'));
const result = join(dir, 'result.json');
copyFileSync('tests/fixtures/fixture-site-result.json', result);
const before = sha(result);
const allow = join(dir, 'allow.txt');
writeFileSync(allow, 'host:www.site.test\n');

const run = await exec(['queue', result, '--allow-file', allow, '--max-candidates', '2', '--max-pages', '1', '--max-energy-runs', '24', '--write']);
check(run.status === 0, `queue --write succeeds (${run.status})`);
check(run.out.includes('This is a plan. No browser or experiment was started.'), 'the command says it is a plan');
check(run.out.includes('selected'), 'the command prints selected candidates');
const queuePath = join(dir, 'result.candidate-queue.json');
check(existsSync(queuePath), 'the sidecar queue is written');
if (existsSync(queuePath)) {
  const q = JSON.parse(readFileSync(queuePath, 'utf8'));
  check(validateCandidateQueue(q).length === 0, 'the queue validates against candidate-queue/1');
  check(q.schema === 'candidate-queue/1', 'the queue names its schema');
  check(q.summary.selected >= 1, 'at least one candidate is selected');
  check(q.summary.uniquePages <= 1, 'the page budget is respected');
  check(q.summary.estimatedEnergyRuns <= 24, 'the energy-run budget is respected');
  check(q.selected.every((c) => c.experiment && c.estimatedEnergyRuns > 0), 'selected candidates have a proposed experiment and a run estimate');
  check(q.rejected.every((c) => !!c.reason), 'every rejected candidate has a reason');
  check(q.selected.every((c) => c.pairing.viewport.width === 1440 && c.pairing.viewport.height === 900), 'the FES viewport is recorded in the pairing key');
}
check(sha(result) === before, 'the measured result is not rewritten');
check(!existsSync(join(dir, 'result.candidate-queue.html')), 'the queue does not start a browser or write a report');

if (failures.length) {
  console.error(`\n${failures.length} queue check(s) failed.`);
  process.exit(1);
}
console.log('\nAll candidate-queue checks passed.');
