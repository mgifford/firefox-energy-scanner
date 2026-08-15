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
import { FirefoxProfilerAdapter } from '../energy/firefox-profiler.js';
import { PowermetricsAdapter } from '../energy/powermetrics.js';
import { NoopAdapter } from '../energy/noop.js';
import { crawl } from '../collect/crawler.js';
import { toCsv, groupByStep } from '../report/csv.js';
import { toHtml } from '../report/html.js';
import { summarize, compare, interleavedOrder } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { SCHEMA_VERSION, type BenchmarkResult, type StepResult } from '../core/types.js';
import { co2jsVersion } from '../core/co2.js';

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
  if (ffxAvail.available) {
    ok('firefox-profiler: power counters expected on this platform (no elevated privileges needed)');
  } else {
    warn(`firefox-profiler: ${ffxAvail.reason}`);
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
  console.log('\nScenario                         Transfer     CO2.js       Energy');
  console.log('-------------------------------------------------------------------');
  for (const [step, runs] of byStep) {
    const bytes = summarize(runs.map((r) => r.network?.transferBytes ?? Number.NaN));
    const co2 = summarize(runs.map((r) => r.co2?.estimatedGrams ?? Number.NaN));
    const energy = summarize(
      runs.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined),
    );
    const name = step.length > 30 ? `${step.slice(0, 27)}...` : step.padEnd(30);
    const kb = Number.isFinite(bytes.median) ? `${(bytes.median / 1024).toFixed(0)} KB`.padStart(10) : '        — ';
    const mg = Number.isFinite(co2.median) ? `${(co2.median * 1000).toFixed(3)} mg`.padStart(12) : '           —';
    const mwh = energy.count
      ? `${joulesToMilliwattHours(energy.median).toFixed(3)} mWh`.padStart(12)
      : '           —';
    console.log(`${name}${kb}${mg}${mwh}`);
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
