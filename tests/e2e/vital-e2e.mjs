#!/usr/bin/env node
/**
 * End-to-end check of the opt-in Vital Core handoff, with synthetic fixtures.
 * No browser is launched: --from-vital only generates a spec.
 *
 * Usage: node tests/e2e/vital-e2e.mjs   (after npm run build)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const SNAPSHOT = 'tests/fixtures/vital/snapshot.json';
const THIRD_PARTY = 'third-party-resource:https://cdn.example.net/widget.js';
const out = mkdtempSync(join(tmpdir(), 'vital-'));
const specFile = join(out, 'widget.yaml');

const generated = await exec(['experiment', '--from-vital', SNAPSHOT, '--candidate', THIRD_PARTY, '--save-spec', specFile, '--dry-run']);
check(generated.status === 0, `the third-party candidate generates a spec (${generated.status})`);
check(/kind: block/.test(generated.out) && /hosts:\s*\n\s+- cdn\.example\.net/.test(generated.out), 'it is a block-host experiment');
check(/url: https:\/\/example\.gov\/a/.test(generated.out), 'it uses the inventory’s representative page');
check(/assertions:\s*\n\s+- role: main/.test(generated.out), 'it carries a functional assertion');
check(/Vital Core candidate/.test(generated.out) && /sha256\s+[a-f0-9]{64}/.test(generated.out), 'the note keeps the candidate and source hash');
check(!/Firefox windows|Run 1\//.test(generated.out), 'no browser or measurement started');

const saved = readFileSync(specFile, 'utf8');
check(/^name: /m.test(saved) && /^note: /m.test(saved), 'the saved spec has a name and a provenance note');
const reread = await exec(['experiment', '--spec', specFile, '--dry-run']);
check(reread.status === 0 && /kind: block/.test(reread.out), 'the saved spec parses and prints again');

const unknown = await exec(['experiment', '--from-vital', SNAPSHOT, '--candidate', 'not-a-candidate', '--dry-run']);
check(unknown.status === 1 && /No Vital Core candidate/.test(unknown.out), 'an unknown candidate ID fails clearly');

const noPage = await exec(['experiment', '--from-vital', SNAPSHOT, '--candidate', 'render-blocking:https://example.gov/no-example.js', '--dry-run']);
check(noPage.status === 1 && /no representative page URL/.test(noPage.out), 'a candidate with no page example is rejected');

const pageOnly = await exec(['experiment', '--from-vital', SNAPSHOT, '--candidate', 'page-family:example', '--dry-run']);
check(pageOnly.status === 1 && /no compatible Firefox experiment/.test(pageOnly.out) && /machine-readable experiment field/.test(pageOnly.out), 'a page-family candidate is rejected with the needed contract');

const bad = join(out, 'bad.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(bad, '{"not":"a snapshot"}');
const malformed = await exec(['experiment', '--from-vital', bad, '--candidate', 'x', '--dry-run']);
check(malformed.status === 1 && /neither a Vital Core snapshot/.test(malformed.out), 'a malformed document is rejected before a spec is made');

if (failures.length) {
  console.error(`\n${failures.length} Vital Core handoff check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Vital Core handoff checks passed.');
