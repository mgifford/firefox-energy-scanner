#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { firefox } from 'playwright';
import {
  defaultConfig,
  loadConfigFile,
  formatConfigError,
  type Config,
} from '../core/config.js';
import { runBenchmark, newSessionId } from '../core/runner.js';
import { loadJourney } from '../core/journey.js';
import { collectEnvironment, readPowerState, playwrightVersion } from './env.js';
import {
  FirefoxProfilerAdapter,
  createProfileOutputPath,
  profilerLaunchEnv,
} from '../energy/firefox-profiler.js';
import { PowermetricsAdapter } from '../energy/powermetrics.js';
import { NoopAdapter } from '../energy/noop.js';
import { crawl } from '../collect/crawler.js';
import { fingerprint, triage } from './triage.js';
import { loadMatrix, triageMatrix, baselineOf } from './matrix.js';
import { collectPageAnatomy, installLcpObserver, readLcp } from '../collect/page-anatomy.js';
import { attributeEnergy } from '../energy/attribution.js';
import { buildFindings } from '../report/findings.js';
import { BrowserSession, waitForStablePage } from '../collect/session.js';
import { readFile } from 'node:fs/promises';
import { parseScanRequest } from './issue-parser.js';
import { buildIndex } from '../report/index-builder.js';
import { interleavedOrderN } from '../core/stats.js';
import { toCsv, groupByStep } from '../report/csv.js';
import { toHtml } from '../report/html.js';
import { summarize, compare, interleavedOrder, median, resolution } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { SCHEMA_VERSION, type BenchmarkResult, type StepResult } from '../core/types.js';
import { co2jsVersion } from '../core/co2.js';
import { describeCapabilities, detectVirtualisation } from '../core/capability.js';

const USAGE = `web-energy — client-side browser energy and modelled CO2e benchmarking

Usage:
  web-energy doctor
  web-energy measure <url...>          [options]
  web-energy crawl <url>               [options]
  web-energy journey <file>            [options]
  web-energy baseline                  [options]
  web-energy compare --a <url> --b <url> --journey <file> [options]
  web-energy report <result.json>
  web-energy profile --journey <file> [--step <name>]
  web-energy triage --a <url> --b <url> [--path <path>]
  web-energy matrix <matrix.yaml> --journey <file> [--triage-only]
  web-energy diagnose <url> [--runs <n>]

Options:
  --config <file>        YAML configuration file
  --runs <n>             Measured runs (default 10)
  --warmups <n>          Warmup runs, excluded from statistics (default 3)
  --out <dir>            Output directory (default "results")
  --headed / --headless  Browser mode (default headed)
  --label-a, --label-b   Labels for compare targets
  --max-pages <n>        Crawl page limit
  --max-depth <n>        Crawl depth limit
  --include <regex>      Crawl include pattern (repeatable)
  --exclude <regex>      Crawl exclude pattern (repeatable)
  --authenticated        Use Drupal auth from environment variables
  --seed <string>        Seed for interleaved A/B ordering
  --no-energy            Disable energy measurement
`;

interface Args {
  _: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        const list = flags.get(key) ?? [];
        list.push(next);
        flags.set(key, list);
        i++;
      } else {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

const one = (args: Args, key: string): string | undefined => args.flags.get(key)?.[0];
const has = (args: Args, key: string): boolean => args.flags.has(key);

async function buildConfig(args: Args): Promise<Config> {
  let config = one(args, 'config') ? await loadConfigFile(one(args, 'config')!) : defaultConfig();

  const runs = one(args, 'runs');
  const warmups = one(args, 'warmups');
  const out = one(args, 'out');

  config = {
    ...config,
    benchmark: {
      ...config.benchmark,
      ...(runs ? { runs: Number.parseInt(runs, 10) } : {}),
      ...(warmups ? { warmups: Number.parseInt(warmups, 10) } : {}),
    },
    browser: {
      ...config.browser,
      ...(has(args, 'headless') ? { headed: false } : {}),
      ...(has(args, 'headed') ? { headed: true } : {}),
    },
    energy: {
      ...config.energy,
      ...(has(args, 'no-energy') ? { adapter: 'noop' as const } : {}),
    },
    crawl: {
      ...config.crawl,
      ...(one(args, 'max-pages') ? { max_pages: Number.parseInt(one(args, 'max-pages')!, 10) } : {}),
      ...(one(args, 'max-depth') ? { max_depth: Number.parseInt(one(args, 'max-depth')!, 10) } : {}),
      ...(args.flags.get('include') ? { include: args.flags.get('include')! } : {}),
      ...(args.flags.get('exclude') ? { exclude: args.flags.get('exclude')! } : {}),
    },
    output: { ...config.output, ...(out ? { directory: out } : {}) },
    ...(has(args, 'authenticated')
      ? {
          auth: config.auth ?? {
            type: 'drupal' as const,
            username_env: 'DRUPAL_USERNAME',
            password_env: 'DRUPAL_PASSWORD',
            login_path: '/user/login',
          },
        }
      : {}),
  };
  return config;
}

/**
 * Launch Firefox briefly with the profiler enabled and count power samples.
 *
 * This is the only reliable way to know whether a host can measure energy:
 * platform and architecture are necessary but not sufficient.
 */
async function probePowerCounters(): Promise<{
  samples: number;
  durationMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const outputPath = await createProfileOutputPath();
    const adapter = new FirefoxProfilerAdapter(outputPath, { intervalMs: 10 });
    const browser = await firefox.launch({
      headless: true,
      env: { ...(process.env as Record<string, string>), ...profilerLaunchEnv(outputPath) },
    });
    const page = await browser.newPage();
    const handle = await adapter.start({ label: 'probe' });
    // A little CPU work so there is something to measure.
    await page.goto(
      'data:text/html,<script>const t=Date.now();let x=0;while(Date.now()-t<1200){x+=Math.sqrt(Math.random());}</script>',
    );
    await page.waitForTimeout(300);
    await adapter.stop(handle);
    await browser.close();
    await new Promise((r) => setTimeout(r, 2000));

    const results = await adapter.finalize();
    const probe = results.get('probe');
    return { samples: probe?.sampleCount ?? 0, durationMs: Date.now() - started };
  } catch (err) {
    return { samples: 0, durationMs: Date.now() - started, error: (err as Error).message };
  }
}

async function cmdDoctor(): Promise<number> {
  const lines: string[] = [];
  let failures = 0;
  const ok = (m: string) => lines.push(`  ok       ${m}`);
  const warn = (m: string) => lines.push(`  warning  ${m}`);
  const fail = (m: string) => {
    lines.push(`  FAIL     ${m}`);
    failures++;
  };

  lines.push('Environment');
  const major = Number.parseInt(process.versions.node.split('.')[0]!, 10);
  major >= 20 ? ok(`Node.js ${process.versions.node}`) : fail(`Node.js ${process.versions.node} (need >= 20)`);
  ok(`Platform ${process.platform}/${process.arch}`);
  ok(`Playwright ${playwrightVersion()}`);
  ok(`CO2.js ${co2jsVersion()}`);

  lines.push('');
  lines.push('Browser');
  try {
    const b = await firefox.launch({ headless: true });
    ok(`Playwright Firefox ${b.version()} launches`);
    await b.close();
  } catch (err) {
    fail(`Firefox failed to launch: ${(err as Error).message}. Run: npx playwright install firefox`);
  }

  lines.push('');
  lines.push('Energy adapters');
  const ffx = new FirefoxProfilerAdapter('/dev/null');
  const ffxAvail = await ffx.available();
  if (!ffxAvail.available) {
    warn(`firefox-profiler: ${ffxAvail.reason}`);
  } else {
    // Platform support is not proof: virtualised macOS hosts expose a power
    // counter that never emits a sample. Run a short real profile to find out.
    const probe = await probePowerCounters();
    if (probe.samples > 0) {
      ok(
        `firefox-profiler: power counters produced ${probe.samples} samples in a ${probe.durationMs} ms probe ` +
          '(no elevated privileges needed)',
      );
    } else if (probe.error) {
      warn(`firefox-profiler: probe could not run (${probe.error})`);
    } else {
      fail(
        'firefox-profiler: the platform reports support but the power counters emitted NO samples. ' +
          'This host cannot measure energy — common on virtualised macOS (e.g. GitHub-hosted runners). ' +
          'Network, CO2.js and timing metrics still work.',
      );
    }
  }

  const pm = new PowermetricsAdapter();
  const pmAvail = await pm.available();
  if (pmAvail.available) {
    ok('macos-powermetrics: available (opt-in; system scope)');
  } else {
    warn(`macos-powermetrics: ${pmAvail.reason}`);
  }
  ok('noop: always available (timing only, never reports energy)');

  lines.push('');
  lines.push('Measurement conditions');
  const power = await readPowerState();
  if (power.onBattery === undefined) {
    warn('Power source could not be determined');
  } else if (power.onBattery) {
    warn(
      `Running on BATTERY (${power.batteryPercent ?? '?'}%). Power management differs on battery; ` +
        'compare runs only against runs made on the same power source.',
    );
  } else {
    ok('Running on AC power');
  }

  if (power.lowPowerMode === undefined) {
    warn('Low Power Mode state could not be determined');
  } else if (power.lowPowerMode) {
    warn(
      'Low Power Mode is ON. It throttles CPU frequency and suppresses measured energy. ' +
        'Turn it off for benchmarking, and never compare these runs against runs made with it off.',
    );
  } else {
    ok('Low Power Mode is off');
  }

  lines.push('');
  lines.push('Credentials');
  if (process.env.DRUPAL_USERNAME && process.env.DRUPAL_PASSWORD) {
    ok('DRUPAL_USERNAME and DRUPAL_PASSWORD are set');
  } else {
    warn('DRUPAL_USERNAME / DRUPAL_PASSWORD not set (needed only for authenticated targets)');
  }

  console.log(lines.join('\n'));
  console.log(failures === 0 ? '\nDoctor: no blocking problems found.' : `\nDoctor: ${failures} blocking problem(s).`);
  return failures === 0 ? 0 : 1;
}

/**
 * Declare what this host could measure, so an absent energy figure is never
 * read as a measured zero.
 */
async function capabilitiesFor(
  energyAvailable: boolean,
): Promise<BenchmarkResult['capabilities']> {
  const virtualised = await detectVirtualisation();
  const c = describeCapabilities({
    powerSamplesObserved: energyAvailable,
    platform: process.platform,
    architecture: process.arch,
    ...(virtualised !== undefined ? { virtualised } : {}),
  });
  return { tier: c.tier, summary: c.summary, unavailable: c.unavailable };
}

async function writeOutputs(result: BenchmarkResult, config: Config): Promise<string> {
  const dir = resolve(config.output.directory);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(dir, `${result.session.mode}-${stamp}`);

  if (config.output.json) await writeFile(`${base}.json`, JSON.stringify(result, null, 2));
  if (config.output.csv) await writeFile(`${base}.csv`, toCsv(result));
  if (config.output.html) await writeFile(`${base}.html`, toHtml(result));
  return base;
}

function printSummary(steps: StepResult[]): void {
  const byStep = groupByStep(steps);
  if (byStep.size === 0) {
    console.log('\nNo measured runs recorded.');
    return;
  }
  console.log('\nScenario                         Transfer     CO2.js       Energy  Resolved');
  console.log('-----------------------------------------------------------------------------');
  let unresolved = 0;
  for (const [step, runs] of byStep) {
    const bytes = summarize(runs.map((r) => r.network?.transferBytes ?? Number.NaN));
    const co2 = summarize(runs.map((r) => r.co2?.estimatedGrams ?? Number.NaN));
    const energyValues = runs
      .map((r) => r.energy?.incrementalJoules)
      .filter((v): v is number => v !== undefined);
    const energy = summarize(energyValues);
    const res = resolution(energyValues);

    // Show the tail of long URLs rather than the head; the distinguishing part
    // of a URL is usually at the end.
    const name = (step.length > 30 ? `...${step.slice(-27)}` : step).padEnd(30);
    const kb = Number.isFinite(bytes.median) ? `${(bytes.median / 1024).toFixed(0)} KB`.padStart(10) : '        — ';
    const mg = Number.isFinite(co2.median) ? `${(co2.median * 1000).toFixed(3)} mg`.padStart(12) : '           —';
    const mwh = energy.count
      ? `${joulesToMilliwattHours(energy.median).toFixed(3)} mWh`.padStart(12)
      : '           —';
    const flag = energy.count === 0 ? '    —' : res.resolved ? '  yes' : '   NO';
    if (energy.count > 0 && !res.resolved) unresolved++;
    console.log(`${name}${kb}${mg}${mwh}${flag}`);
  }

  if (unresolved > 0) {
    console.log(
      `\nwarning: ${unresolved} scenario(s) marked NO under "Resolved": the measured energy is\n` +
        'smaller than its own run-to-run spread (|median| < IQR). Those values are below the\n' +
        'resolution of this setup and must not be reported as differences. Lightweight static\n' +
        'pages commonly fall here — they paint and then the browser goes idle.',
    );
  }

  console.log(
    '\nCO2.js is a modelled estimate from transferred bytes. Energy is observed on this client.\nThey have different system boundaries and are not interchangeable.',
  );
}

async function cmdMeasure(args: Args): Promise<number> {
  const urls = args._.slice(1);
  if (urls.length === 0) {
    console.error('measure requires at least one URL');
    return 1;
  }
  const config = await buildConfig(args);
  const outcome = await runBenchmark({
    config,
    baseUrl: urls[0]!,
    urls,
    scenarioName: 'measure',
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(40)}`),
  });
  process.stderr.write('\n');

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: { id: newSessionId(), startedAt: new Date().toISOString(), mode: 'measure' },
    capabilities: await capabilitiesFor(outcome.energyAvailable),
    environment: await collectEnvironment({
      energyAdapter: config.energy.adapter,
      headed: config.browser.headed,
      viewport: config.browser.viewport,
      firefoxVersion: outcome.firefoxVersion,
      collectHostname: config.output.collect_hostname,
    }),
    target: { url: urls[0]! },
    configuration: config,
    scenarios: outcome.steps,
    ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
    warnings: outcome.warnings,
  };

  const base = await writeOutputs(result, config);
  printSummary(outcome.steps);
  for (const w of outcome.warnings) console.log(`\nwarning: ${w}`);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

async function cmdJourney(args: Args): Promise<number> {
  const file = args._[1];
  if (!file) {
    console.error('journey requires a journey file');
    return 1;
  }
  const config = await buildConfig(args);
  const journey = await loadJourney(resolve(file));
  const baseUrl = one(args, 'url') ?? config.target?.url ?? process.env.DRUPAL_BASE_URL;
  if (!baseUrl) {
    console.error('No base URL. Provide --url, a config target.url, or DRUPAL_BASE_URL.');
    return 1;
  }

  const outcome = await runBenchmark({
    config,
    baseUrl,
    journey,
    scenarioName: journey.name,
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(40)}`),
  });
  process.stderr.write('\n');

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: { id: newSessionId(), startedAt: new Date().toISOString(), mode: 'journey' },
    capabilities: await capabilitiesFor(outcome.energyAvailable),
    environment: await collectEnvironment({
      energyAdapter: config.energy.adapter,
      headed: config.browser.headed,
      viewport: config.browser.viewport,
      firefoxVersion: outcome.firefoxVersion,
      collectHostname: config.output.collect_hostname,
    }),
    target: { url: baseUrl, ...(config.target?.label ? { label: config.target.label } : {}) },
    configuration: config,
    scenarios: outcome.steps,
    ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
    warnings: outcome.warnings,
  };

  const base = await writeOutputs(result, config);
  printSummary(outcome.steps);
  for (const w of outcome.warnings) console.log(`\nwarning: ${w}`);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

async function cmdCrawl(args: Args): Promise<number> {
  const start = args._[1];
  if (!start) {
    console.error('crawl requires a start URL');
    return 1;
  }
  const config = await buildConfig(args);
  const outcome = await crawl({
    config,
    startUrl: start,
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(70)}`),
  });
  process.stderr.write('\n');

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: { id: newSessionId(), startedAt: new Date().toISOString(), mode: 'crawl' },
    capabilities: await capabilitiesFor(outcome.energyAvailable),
    environment: await collectEnvironment({
      energyAdapter: config.energy.adapter,
      headed: config.browser.headed,
      viewport: config.browser.viewport,
      firefoxVersion: outcome.firefoxVersion,
      collectHostname: config.output.collect_hostname,
    }),
    target: { url: start },
    configuration: config,
    scenarios: outcome.steps,
    ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
    warnings: [
      ...outcome.warnings,
      'Crawl mode is for discovery and broad assessment. It is not a controlled regression workload; use journey mode for A/B comparisons.',
    ],
  };

  const base = await writeOutputs(result, config);
  printSummary(outcome.steps);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

async function cmdBaseline(args: Args): Promise<number> {
  const config = await buildConfig(args);
  const outcome = await runBenchmark({
    config: { ...config, benchmark: { ...config.benchmark, runs: 1, warmups: 0 } },
    baseUrl: 'about:blank',
    urls: ['about:blank'],
    scenarioName: 'baseline',
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(40)}`),
  });
  process.stderr.write('\n');

  if (outcome.baseline) {
    console.log(`Idle baseline: ${outcome.baseline.watts.toFixed(4)} W`);
    console.log(`  duration ${outcome.baseline.durationMs} ms, ${outcome.baseline.samples} samples`);
    console.log(`  adapter  ${outcome.baseline.adapterId}`);
  } else {
    console.log('No baseline could be derived (no energy data available on this platform).');
  }
  for (const w of outcome.warnings) console.log(`warning: ${w}`);
  return 0;
}

async function cmdCompare(args: Args): Promise<number> {
  const a = one(args, 'a');
  const b = one(args, 'b');
  const journeyFile = one(args, 'journey');
  if (!a || !b || !journeyFile) {
    console.error('compare requires --a <url> --b <url> --journey <file>');
    return 1;
  }
  const config = await buildConfig(args);
  const journey = await loadJourney(resolve(journeyFile));
  const seed = one(args, 'seed') ?? newSessionId();
  const labelA = one(args, 'label-a') ?? 'a';
  const labelB = one(args, 'label-b') ?? 'b';

  // Interleave so drift in thermal/network/server state is not confounded
  // with the target being measured.
  const order = interleavedOrder(config.benchmark.runs, seed);
  const perTarget: Record<'a' | 'b', StepResult[]> = { a: [], b: [] };
  let firefoxVersion = 'unknown';
  const warnings: string[] = [];

  console.log(`Interleaved order (seed ${seed}): ${order.join(' ')}`);

  for (const [i, which] of order.entries()) {
    const url = which === 'a' ? a : b;
    process.stderr.write(`\rRun ${i + 1}/${order.length} -> ${which === 'a' ? labelA : labelB}`.padEnd(50));
    const outcome = await runBenchmark({
      config: { ...config, benchmark: { ...config.benchmark, runs: 1, warmups: i === 0 ? config.benchmark.warmups : 0 } },
      baseUrl: url,
      journey,
      scenarioName: which === 'a' ? labelA : labelB,
    });
    firefoxVersion = outcome.firefoxVersion;
    warnings.push(...outcome.warnings);
    perTarget[which].push(...outcome.steps);
  }
  process.stderr.write('\n');

  // A journey that navigates to absolute paths (e.g. '/') resolves against the
  // target ORIGIN, so pointing --a/--b at two paths on the same host silently
  // measures the same page twice. Detect that rather than reporting a
  // meaningless difference.
  const loadedA = new Set(perTarget.a.filter((s) => !s.warmup).map((s) => s.url));
  const loadedB = new Set(perTarget.b.filter((s) => !s.warmup).map((s) => s.url));
  const overlap = [...loadedA].filter((u) => loadedB.has(u));
  if (overlap.length > 0) {
    warnings.push(
      `Both targets loaded the same URL(s): ${overlap.slice(0, 3).join(', ')}. ` +
        'The journey likely navigates to absolute paths, which resolve against the target origin. ' +
        'Point --a/--b at the two origins being compared, or use a journey with matching relative routes.',
    );
  }

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: {
      id: newSessionId(),
      startedAt: new Date().toISOString(),
      mode: 'compare',
      seed,
      orderings: order,
    },
    environment: await collectEnvironment({
      energyAdapter: config.energy.adapter,
      headed: config.browser.headed,
      viewport: config.browser.viewport,
      firefoxVersion,
      collectHostname: config.output.collect_hostname,
    }),
    targets: [
      { url: a, label: labelA },
      { url: b, label: labelB },
    ],
    configuration: config,
    scenarios: [...perTarget.a, ...perTarget.b],
    warnings: [...new Set(warnings)],
  };

  const base = await writeOutputs(result, config);

  console.log(`\nScenario                    ${labelA.padEnd(12)}${labelB.padEnd(12)}Change`);
  console.log('-----------------------------------------------------------------');
  const stepsA = groupByStep(perTarget.a);
  const stepsB = groupByStep(perTarget.b);
  for (const [step, runsA] of stepsA) {
    const runsB = stepsB.get(step) ?? [];
    const energyA = runsA.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const energyB = runsB.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    if (energyA.length === 0 || energyB.length === 0) continue;
    const cmp = compare(energyA, energyB);
    const mA = joulesToMilliwattHours(cmp.a.median).toFixed(3);
    const mB = joulesToMilliwattHours(cmp.b.median).toFixed(3);
    const pct = Number.isFinite(cmp.percentDifference) ? `${cmp.percentDifference.toFixed(1)}%` : '—';
    console.log(`${step.slice(0, 26).padEnd(28)}${`${mA} mWh`.padEnd(12)}${`${mB} mWh`.padEnd(12)}${pct}`);
    if (cmp.qualification) console.log(`   note: ${cmp.qualification}`);
  }
  for (const w of new Set(warnings)) console.log(`\nwarning: ${w}`);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

/**
 * Fast pre-flight check: can this pair of targets possibly differ in
 * client-side energy? Seconds instead of the many minutes a full A/B costs.
 */
async function cmdTriage(args: Args): Promise<number> {
  const a = one(args, 'a');
  const b = one(args, 'b');
  if (!a || !b) {
    console.error('triage requires --a <url> --b <url>');
    return 1;
  }
  // A bare `--path` (no value) parses as "true"; treat that and an empty value
  // as "use the URLs exactly as given".
  const rawPath = one(args, 'path');
  const path = rawPath && rawPath !== 'true' ? rawPath : undefined;
  const urlA = path ? new URL(path, a).toString() : a;
  const urlB = path ? new URL(path, b).toString() : b;

  console.log(`Comparing delivered payloads${path ? ` for ${path}` : ''}\n  a: ${urlA}\n  b: ${urlB}\n`);

  if (urlA === urlB) {
    console.log('Both targets resolve to the same URL; there is nothing to compare.');
    return 1;
  }

  const [fa, fb] = await Promise.all([fingerprint(urlA), fingerprint(urlB)]);
  const verdict = triage(fa, fb);

  console.log(`  HTTP status  a=${fa.status || 'error'}  b=${fb.status || 'error'}`);
  console.log(`  HTML bytes   a=${fa.htmlBytes}  b=${fb.htmlBytes}  (${verdict.byteDelta >= 0 ? '+' : ''}${verdict.byteDelta})`);
  console.log(`  HTML hash    ${verdict.htmlIdentical ? 'identical' : `differs (${fa.htmlHash} vs ${fb.htmlHash})`}`);
  console.log(`  Scripts      a=${fa.scripts.length}  b=${fb.scripts.length}  ${verdict.scriptsIdentical ? 'identical' : 'DIFFER'}`);
  console.log(`  Stylesheets  a=${fa.styles.length}  b=${fb.styles.length}  ${verdict.stylesIdentical ? 'identical' : 'DIFFER'}`);

  for (const s of verdict.addedScripts) console.log(`    + script ${s}`);
  for (const s of verdict.removedScripts) console.log(`    - script ${s}`);
  for (const s of verdict.addedStyles) console.log(`    + style  ${s}`);
  for (const s of verdict.removedStyles) console.log(`    - style  ${s}`);

  const inconclusive = verdict.reasons.some((r) => r.startsWith('Inconclusive'));
  const label = inconclusive
    ? 'INCONCLUSIVE'
    : verdict.worthMeasuring
      ? 'WORTH MEASURING'
      : 'NOT worth measuring for client energy';
  console.log(`\nVerdict: ${label}`);
  for (const r of verdict.reasons) console.log(`  ${r}`);
  console.log(
    '\nNote: this compares anonymous responses only. An authenticated page may differ\n' +
      'where an anonymous one does not, so re-check with --path on an admin route if relevant.',
  );
  return 0;
}

/**
 * Measure N targets against a shared baseline in one interleaved session.
 *
 * Patch-vs-patch comparison is confounded, so every patch is compared to a
 * common reference instead, and the differences are what get ranked.
 */
async function cmdMatrix(args: Args): Promise<number> {
  const file = args._[1];
  if (!file) {
    console.error('matrix requires a matrix YAML file');
    return 1;
  }
  const spec = await loadMatrix(resolve(file));
  const baseline = baselineOf(spec);
  const path = (() => {
    const raw = one(args, 'path');
    return raw && raw !== 'true' ? raw : undefined;
  })();

  console.log(`Matrix: ${spec.targets.length} targets, baseline = ${baseline.label}\n`);

  // Pre-screen: skip anything whose payload matches the baseline.
  console.log('Triage (delivered payload vs baseline)');
  const rows = await triageMatrix(spec, path);
  for (const r of rows) {
    const flag = r.target === baseline ? ' ' : r.inconclusive ? '?' : r.differsFromBaseline ? '*' : '-';
    console.log(
      `  ${flag} ${r.target.label.padEnd(24)} ${String(r.fingerprint.status).padStart(3)}  ${r.summary}`,
    );
  }
  console.log('\n  * differs from baseline (measure)   - identical payload (skip)   ? inconclusive');

  const measurable = rows.filter(
    (r) => r.target === baseline || (r.differsFromBaseline && !r.inconclusive),
  );
  const skipped = rows.filter((r) => r !== undefined && !measurable.includes(r));

  if (skipped.length > 0) {
    console.log('\nSkipping (cannot differ in client energy, or unreachable):');
    for (const r of skipped) console.log(`  ${r.target.label} — ${r.summary}`);
  }

  if (has(args, 'triage-only')) return 0;

  if (measurable.length < 2) {
    console.log(
      '\nFewer than two measurable targets remain. Nothing to compare.\n' +
        'Either the patches do not change delivered payload, or the previews are unreachable.',
    );
    return 1;
  }

  const journeyFile = one(args, 'journey');
  if (!journeyFile) {
    console.error('\nmatrix requires --journey <file> unless --triage-only is given');
    return 1;
  }
  const journey = await loadJourney(resolve(journeyFile));
  const config = await buildConfig(args);
  const seed = one(args, 'seed') ?? newSessionId();
  const labels = measurable.map((r) => r.target.label);
  const order = interleavedOrderN(labels, config.benchmark.runs, seed);

  console.log(`\nInterleaved order (seed ${seed}):\n  ${order.join(' ')}\n`);

  const byLabel = new Map<string, StepResult[]>();
  const warnings: string[] = [];
  let firefoxVersion = 'unknown';

  for (const [i, label] of order.entries()) {
    const target = measurable.find((r) => r.target.label === label)!.target;
    process.stderr.write(`\rRun ${i + 1}/${order.length} -> ${label}`.padEnd(50));
    const outcome = await runBenchmark({
      config: {
        ...config,
        benchmark: {
          ...config.benchmark,
          runs: 1,
          // Warm only on the first visit to each target.
          warmups: byLabel.has(label) ? 0 : config.benchmark.warmups,
        },
      },
      baseUrl: target.url,
      journey,
      scenarioName: label,
    });
    firefoxVersion = outcome.firefoxVersion;
    warnings.push(...outcome.warnings);
    byLabel.set(label, [...(byLabel.get(label) ?? []), ...outcome.steps]);
  }
  process.stderr.write('\n');

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: { id: newSessionId(), startedAt: new Date().toISOString(), mode: 'compare', seed, orderings: order },
    environment: await collectEnvironment({
      energyAdapter: config.energy.adapter,
      headed: config.browser.headed,
      viewport: config.browser.viewport,
      firefoxVersion,
      collectHostname: config.output.collect_hostname,
    }),
    targets: measurable.map((r) => ({
      url: r.target.url,
      label: r.target.label,
      ...(r.target.mr ? { commit: r.target.mr } : {}),
    })),
    configuration: config,
    scenarios: [...byLabel.values()].flat(),
    warnings: [...new Set(warnings)],
  };

  const base = await writeOutputs(result, config);
  printMatrix(byLabel, baseline.label);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

/** Rank each target's steps against the baseline's median energy. */
function printMatrix(byLabel: Map<string, StepResult[]>, baselineLabel: string): void {
  const baselineSteps = byLabel.get(baselineLabel);
  if (!baselineSteps) {
    console.log('\nBaseline produced no measurements.');
    return;
  }
  const energyByStep = (steps: StepResult[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const s of steps) {
      if (s.warmup) continue;
      const v = s.energy?.incrementalJoules;
      if (v === undefined) continue;
      m.set(s.step, [...(m.get(s.step) ?? []), v]);
    }
    return m;
  };

  const baseEnergy = energyByStep(baselineSteps);
  const stepNames = [...baseEnergy.keys()];

  console.log(`\nIncremental energy vs baseline "${baselineLabel}" (median mWh, and % change)\n`);
  const header = ['step'.padEnd(20), ...[...byLabel.keys()].map((l) => l.slice(0, 14).padStart(16))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const step of stepNames) {
    const cells: string[] = [step.slice(0, 19).padEnd(20)];
    const baseMedian = median(baseEnergy.get(step) ?? []);
    for (const [label, steps] of byLabel) {
      const values = energyByStep(steps).get(step) ?? [];
      if (values.length === 0) {
        cells.push('—'.padStart(16));
        continue;
      }
      const m = median(values);
      const mwh = joulesToMilliwattHours(m).toFixed(3);
      if (label === baselineLabel || !Number.isFinite(baseMedian) || baseMedian === 0) {
        cells.push(mwh.padStart(16));
      } else {
        const pct = ((m - baseMedian) / Math.abs(baseMedian)) * 100;
        cells.push(`${mwh} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`.padStart(16));
      }
    }
    console.log(cells.join(''));
  }

  const runCount = Math.min(
    ...[...byLabel.values()].map((s) => s.filter((x) => !x.warmup).length),
  );
  if (runCount < 10) {
    console.log(
      `\nnote: as few as ${runCount} measured runs per target. Treat as indicative only; ` +
        'no significance is claimed.',
    );
  }
}

/** Parse a scan request from an issue body file (used by CI). */
async function cmdParseIssue(args: Args): Promise<number> {
  const file = one(args, 'file');
  if (!file) {
    console.error('parse-issue requires --file <path>');
    return 1;
  }
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(resolve(file), 'utf8');
  const request = parseScanRequest(body);
  // Machine-readable on stdout so the workflow can consume it.
  console.log(JSON.stringify(request, null, 2));
  return request.urls.length > 0 ? 0 : 1;
}

/** Rebuild results/index.json from stored result files (used by CI). */
async function cmdBuildIndex(args: Args): Promise<number> {
  const dir = one(args, 'dir') ?? 'site/results';
  const out = one(args, 'out') ?? join(dir, 'index.json');
  const index = await buildIndex(resolve(dir), resolve(out));
  console.log(`Indexed ${index.entries.length} result file(s) -> ${out}`);
  return 0;
}

/**
 * Explain WHERE a page spends browser effort.
 *
 * Firefox's power counter is whole-process and the profile carries no DOM node
 * references, so no tool can attribute joules to an element. This instead
 * reports category CPU shares (apportioning the measured energy) alongside the
 * page structures that drive that work.
 */
async function cmdDiagnose(args: Args): Promise<number> {
  const url = args._[1];
  if (!url) {
    console.error('diagnose requires a URL');
    return 1;
  }
  const config = await buildConfig(args);
  // Stack sampling is needed to attribute categories, which adds overhead —
  // acceptable here because this is a diagnostic run, not a benchmark.
  const diagnosticConfig: Config = {
    ...config,
    benchmark: { ...config.benchmark, runs: 1, warmups: 1 },
    energy: { ...config.energy, retain_profile: true },
  };

  console.log(`Diagnosing ${url}\n`);
  console.log(
    'Note: this is a diagnostic run. Stack sampling changes the workload, so these\n' +
      'numbers must not be mixed with benchmark results.\n',
  );

  // 'cpu' is what populates threadCPUDelta; without it sample rows are
  // truncated and carry no CPU time, so attribution has nothing to weight by.
  const session = await BrowserSession.create(diagnosticConfig, true, [
    'js',
    'stackwalk',
    'cpu',
  ]);
  let anatomy;
  let lcp;
  let energyJoules: number | undefined;
  let profile: unknown;
  let windowStart = 0;
  let windowEnd = 0;

  try {
    const page = session.getPage();
    await installLcpObserver(page);

    // Warmup, then the measured pass.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStablePage(page, diagnosticConfig.stability);

    const handle = await session.energy?.start({ label: 'diagnose' });
    windowStart = handle?.startedAt ?? Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForStablePage(page, diagnosticConfig.stability);
    windowEnd = Date.now();
    if (handle) await session.energy?.stop(handle);

    anatomy = await collectPageAnatomy(page);
    lcp = await readLcp(page);
    if (anatomy && lcp) anatomy.lcpElement = lcp;

    const profilePath = session.profilePath();
    await session.close();

    // Read the raw profile BEFORE finalize(), which deletes it unless
    // retain_profile is set. Attribution needs the full profile, not just the
    // power counters finalize() extracts.
    if (profilePath) {
      profile = JSON.parse(await readFile(profilePath, 'utf8').catch(() => 'null'));
    }
    const results = (await session.energy?.finalize()) ?? new Map();
    energyJoules = results.get('diagnose')?.totalJoules;
  } finally {
    await session.close().catch(() => {});
  }

  const attribution = profile
    ? attributeEnergy(profile, windowStart, windowEnd, energyJoules)
    : undefined;

  if (attribution && attribution.totalCpuMs > 0) {
    console.log('Where the browser spent CPU time');
    console.log('  category          CPU ms     share' + (energyJoules !== undefined ? '   apportioned' : ''));
    for (const c of attribution.categories) {
      const line =
        '  ' + c.category.padEnd(16) +
        c.cpuMs.toFixed(0).padStart(8) +
        (c.share * 100).toFixed(1).padStart(9) + '%';
      console.log(
        line + (c.apportionedJoules !== undefined ? `${(c.apportionedJoules * 1000).toFixed(1)} mJ`.padStart(14) : ''),
      );
    }
    console.log(`\n  ${attribution.assumption}`);
    if (energyJoules === undefined) {
      console.log('  (No energy measured on this host, so only CPU shares are shown.)');
    }
    console.log('');
  }

  if (anatomy) {
    console.log('Page composition');
    console.log(`  DOM nodes        ${anatomy.domNodes.toLocaleString()} (max depth ${anatomy.domDepth})`);
    console.log(`  CSS              ${anatomy.cssRules.toLocaleString()} rules, ${anatomy.cssSelectors.toLocaleString()} selectors, ${anatomy.stylesheets} sheets`);
    console.log(`  Scripts          ${anatomy.scripts} (${anatomy.inlineScripts} inline)`);
    console.log(`  Images           ${anatomy.images} (${anatomy.imagesWithoutDimensions} without dimensions)`);
    console.log(`  Iframes          ${anatomy.iframes}`);
    console.log(`  Animated         ${anatomy.animatedElements} elements`);
    if (anatomy.lcpElement) {
      console.log(
        `  LCP element      ${anatomy.lcpElement.selector} at ${Math.round(anatomy.lcpElement.renderTimeMs)} ms`,
      );
    }
    if (anatomy.heaviestSubtrees.length > 0) {
      console.log('\n  Heaviest subtrees');
      for (const s of anatomy.heaviestSubtrees) {
        console.log(`    ${s.selector.padEnd(40)} ${s.nodes.toLocaleString()} nodes`);
      }
    }
    console.log('');
  }

  const findings = buildFindings(anatomy, attribution);
  if (findings.length === 0) {
    console.log('No structural findings above the reporting thresholds.');
  } else {
    console.log(`Findings (${findings.length})`);
    for (const f of findings) {
      console.log(`\n  [${f.severity.toUpperCase()}] ${f.title}   (${f.category})`);
      console.log(`    ${f.evidence}`);
      console.log(`    -> ${f.action}`);
    }
  }

  console.log(
    '\nWhat this cannot tell you: Firefox has no per-element power counter, and the\n' +
      'profile carries no DOM node references (Mozilla bugs 789712 and 713031 remain open).\n' +
      'These are the structures that drive browser work, not per-element energy.',
  );
  return 0;
}

async function cmdReport(args: Args): Promise<number> {
  const file = args._[1];
  if (!file) {
    console.error('report requires a result JSON file');
    return 1;
  }
  const { readFile } = await import('node:fs/promises');
  const result = JSON.parse(await readFile(resolve(file), 'utf8')) as BenchmarkResult;
  const outPath = resolve(file).replace(/\.json$/, '') + '.html';
  await writeFile(outPath, toHtml(result));
  await writeFile(resolve(file).replace(/\.json$/, '') + '.csv', toCsv(result));
  console.log(`Regenerated ${outPath}`);
  printSummary(result.scenarios);
  return 0;
}

async function cmdProfile(args: Args): Promise<number> {
  const journeyFile = one(args, 'journey');
  if (!journeyFile) {
    console.error('profile requires --journey <file>');
    return 1;
  }
  const config = await buildConfig(args);
  const journey = await loadJourney(resolve(journeyFile));
  const baseUrl = one(args, 'url') ?? config.target?.url ?? process.env.DRUPAL_BASE_URL;
  if (!baseUrl) {
    console.error('No base URL. Provide --url or set DRUPAL_BASE_URL.');
    return 1;
  }

  console.log(
    'Diagnostic profiling run. Stack sampling adds overhead and changes the workload;\n' +
      'these results must NOT be mixed with normal benchmark measurements.\n',
  );

  const diagnosticConfig: Config = {
    ...config,
    benchmark: { ...config.benchmark, runs: 1, warmups: 0 },
    energy: { ...config.energy, retain_profile: true, baseline: false },
  };

  const outcome = await runBenchmark({
    config: diagnosticConfig,
    baseUrl,
    journey,
    scenarioName: `${journey.name} (diagnostic)`,
  });

  console.log('Diagnostic run complete.');
  console.log('The retained Gecko profile can be opened at https://profiler.firefox.com/ (Load from file).');
  for (const w of outcome.warnings) console.log(`warning: ${w}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || has(args, 'help') || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  try {
    switch (command) {
      case 'doctor': return await cmdDoctor();
      case 'measure': return await cmdMeasure(args);
      case 'crawl': return await cmdCrawl(args);
      case 'journey': return await cmdJourney(args);
      case 'baseline': return await cmdBaseline(args);
      case 'compare': return await cmdCompare(args);
      case 'report': return await cmdReport(args);
      case 'profile': return await cmdProfile(args);
      case 'triage': return await cmdTriage(args);
      case 'matrix': return await cmdMatrix(args);
      case 'diagnose': return await cmdDiagnose(args);
      case 'parse-issue': return await cmdParseIssue(args);
      case 'build-index': return await cmdBuildIndex(args);
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === 'ZodError') {
      console.error('Configuration is invalid:\n' + formatConfigError(err));
    } else {
      console.error(`Error: ${e.message}`);
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
