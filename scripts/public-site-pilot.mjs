#!/usr/bin/env node
/**
 * Bounded structural pilot of one public site.
 *
 * Example (after npm run build):
 *   node scripts/public-site-pilot.mjs --url https://www.example.org/ \
 *     --max-pages 20 --out results/pilot-example --confirm-public
 *
 * Dry run (no network, no files):
 *   node scripts/public-site-pilot.mjs --url https://www.example.org/ --dry-run
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPilotPlan, PILOT_SCHEMA } from '../dist/analysis/pilot.js';

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

if (has('--help') || has('-h')) {
  console.log(`Usage: public-site-pilot --url <https://public-site/> [--name <slug>] [--max-pages 20] [--out <dir>] [--timeout-min 20] [--dry-run] --confirm-public

Structural Chromium crawl with --no-energy, Lighthouse and traces, then patterns
and investigation. It never runs an experiment or a Firefox energy measurement.
--confirm-public is required for a real run; use --dry-run to print the plan.`);
  process.exit(0);
}

const url = value('--url');
if (!url) {
  console.error('Missing --url <https://public-site/>. See --help.');
  process.exit(1);
}
const maxPagesRaw = value('--max-pages');
const timeoutMin = Number(value('--timeout-min') ?? 20);
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
  console.error('--timeout-min must be a positive number.');
  process.exit(1);
}
const maxPages = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : undefined;
if (maxPagesRaw && !Number.isFinite(maxPages)) {
  console.error('--max-pages must be an integer.');
  process.exit(1);
}

let plan;
try {
  plan = buildPilotPlan({ url, ...(value('--name') ? { name: value('--name') } : {}), ...(maxPages !== undefined ? { maxPages } : {}), ...(value('--out') ? { outDir: value('--out') } : {}) });
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}

if (has('--dry-run')) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (!has('--confirm-public')) {
  console.error('Refusing to crawl a public site without --confirm-public.');
  console.error('Review the plan with --dry-run, then pass --confirm-public.');
  process.exit(1);
}

const run = (command, env = {}) =>
  new Promise((resolve, reject) => {
    console.error(`\n$ ${command.join(' ')}`);
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMin} minutes: ${command.join(' ')}`));
    }, timeoutMin * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Command exited ${code}: ${command.join(' ')}`));
    });
  });

const manifestPath = join(plan.outDir, 'pilot.json');
const writeManifest = async (extra) => {
  await mkdir(plan.outDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schema: PILOT_SCHEMA,
        startedAt: new Date().toISOString(),
        ...plan,
        ...extra,
      },
      null,
      2,
    ) + '\n',
  );
};

try {
  await mkdir(plan.outDir, { recursive: true });
  await writeManifest({ status: 'running', result: null });
  await run(plan.crawl, plan.environment);

  const files = (await readdir(plan.outDir))
    .filter((f) => /^crawl-.*\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error(`No crawl result found in ${plan.outDir}.`);
  let newest = files[0];
  let newestMs = 0;
  for (const f of files) {
    const s = await stat(join(plan.outDir, f));
    if (s.mtimeMs > newestMs) {
      newest = f;
      newestMs = s.mtimeMs;
    }
  }
  const result = join(plan.outDir, newest);
  await writeManifest({ status: 'crawl-complete', result });

  for (const command of plan.followUps) {
    await run(command.map((x) => (x === plan.resultPattern ? result : x)), plan.environment);
  }
  await writeManifest({ status: 'structural-complete', result });
  console.log(`\nPilot complete: ${result}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log('Next: review the families, patterns and investigation with a human.');
  console.log('Then choose one page for a Firefox diagnose and one component for a controlled experiment on the quiet Mac.');
  console.log('No energy was measured by this pilot.');
} catch (e) {
  await writeManifest({ status: 'failed', error: String(e instanceof Error ? e.message : e) }).catch(() => {});
  console.error(`\nPilot failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
