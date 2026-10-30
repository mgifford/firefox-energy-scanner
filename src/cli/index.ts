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
import { collectTwigTemplates } from '../drupal/twig-debug.js';
import { BrowserSession, waitForStablePage } from '../collect/session.js';
import { readFile } from 'node:fs/promises';
import { parseScanRequest } from './issue-parser.js';
import { buildIndex } from '../report/index-builder.js';
import { interleavedOrderN } from '../core/stats.js';
import { toCsv, groupByStep, failedSteps } from '../report/csv.js';
import { readableFailure } from '../core/failures.js';
import { friendlyError } from './errors.js';
import { toHtml } from '../report/html.js';
import { summarize, compare, interleavedOrder, median, resolution } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import {
  describeGrid,
  energyCarbon,
  formatMicrograms,
  resolveGridIntensity,
  type GridIntensity,
} from '../core/carbon.js';
import { SCHEMA_VERSION, type BenchmarkResult, type StepResult } from '../core/types.js';
import { co2jsVersion } from '../core/co2.js';
import { describeCapabilities } from '../core/capability.js';
import { collectHostFacts, judgeEnergy, type EnergyProbe, type FirefoxProbe } from '../energy/probe.js';
import { formFactorFor, parseCategories, runLighthouse } from '../lighthouse/run.js';
import { pickLighthouseUrls } from '../lighthouse/select.js';
import { collectWebnrg, runWebnrg, type WebnrgSummary } from '../webnrg/run.js';
import { webnrgMarkdown } from '../webnrg/markdown.js';
import { has, one, parseArgs, type Args } from './args.js';
import {
  cruxApiKey,
  cruxTarget,
  describeCrux,
  fetchCrux,
  formatCruxShare,
  formatCruxValue,
  CRUX_LABELS,
  CRUX_METRICS,
  type CruxFormFactorFilter,
  type CruxRequest,
  type CruxResult,
  type CruxScope,
} from '../core/crux.js';
import {
  scoreRating,
  sitewideRecommendations,
  type FormFactor,
  type LighthouseSummary,
} from '../lighthouse/summary.js';

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
  web-energy lighthouse <url...>       [--lighthouse-* options]
  web-energy crux <url>                [--crux-* options]
  web-energy webnrg <url...>           [--lookup-only] [--wait <minutes>]
  web-energy webnrg-collect <file.json> [--wait <minutes>] [--markdown <file>]

Options:
  --config <file>        YAML configuration file
  --runs <n>             Measured runs (default 10)
  --warmups <n>          Warmup runs, excluded from statistics (default 3)
  --out <dir>            Output directory (default "results")
  --headed / --headless  Browser mode (default headed)
  --viewport <WxH>       Browser viewport, e.g. 1280x800 (default 1440x900)
  --label-a, --label-b   Labels for compare targets
  --max-pages <n>        Crawl page limit
  --max-depth <n>        Crawl depth limit
  --include <regex>      Crawl include pattern (repeatable)
  --exclude <regex>      Crawl exclude pattern (repeatable)
  --authenticated        Use Drupal auth from environment variables
  --seed <string>        Seed for interleaved A/B ordering
  --no-energy            Disable energy measurement
  --green-hosting        Ask the Green Web Foundation which domains each page
                         loaded from are green-hosted, and model those bytes
                         as such (CO2.js). Sends the domain names, after the
                         browser has closed.
  --public-only          Refuse private and local addresses (localhost, LAN,
                         DDEV and similar) for every connection the browser
                         makes, including redirects and page resources. Use it
                         whenever the URLs come from someone else.

Grid-derived carbon (Class C; optional, never derived from the CO2.js estimate):
  --grid-intensity <n>   gCO2e per kWh for the client's grid
  --grid-zone <code>     ISO country code for a bundled annual average (e.g. CA, GBR)
  --grid-kind <k>        average (default) or marginal
  --grid-source <text>   Provenance recorded alongside the figure
  --grid-year <n>        Reference year for --grid-intensity

Lighthouse (optional; runs in Chromium after the Firefox session has closed):
  --lighthouse                  Also run Lighthouse on measure/crawl targets
  --lighthouse-runs <n>         Runs per URL; the median is reported (default 3)
  --lighthouse-categories <c>   performance (default), a comma list, or "all"
  --lighthouse-form-factor <f>  mobile | desktop (default: from the viewport)
  --lighthouse-top <n|all>      Audit only the n heaviest pages (crawl default 10;
                                lists default all)
  --lighthouse-reports <dir>    Also write each URL's full HTML report here

Field data (CrUX; optional, read-only, needs a Chrome UX Report API key):
  --crux                        Query the Chrome UX Report and report real-user p75
                                metrics beside the lab results
  --crux-url                    Ask about the URL instead of its whole origin
  --crux-form-factor <f>        all (default) | phone | desktop | tablet
  --crux-key <key>              API key; prefer the CRUX_API_KEY environment variable

  \`crux <url>\` queries the field data on its own, without launching a browser.

webNRG lab check (optional; Green Coding's Green Metrics Tool cluster):
  --webnrg                Look up webNRG figures for the top pages and request
                          new ones where none exist from the last 30 days.
                          Sends those page URLs to green-coding.io; every
                          webNRG result is public.
  --webnrg-lookup-only    Only reuse existing webNRG results; send nothing new
  --webnrg-top <n>        Pages to check (default 3, at most 10)
  --webnrg-wait <min>     Minutes to wait for requested results (default 0;
                          collect them later with webnrg-collect)
`;


/** `--viewport 1280x800`. Rejects anything else rather than guessing. */
function parseViewportFlag(raw: string): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim());
  if (!m) throw new Error(`--viewport must look like 1280x800 (got "${raw}")`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseNumberFlag(name: string, raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
  return n;
}

function parseIntegerFlag(name: string, raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number (got "${raw}")`);
  return n;
}

function parseGridKind(raw: string): 'average' | 'marginal' {
  const value = raw.trim();
  if (value !== 'average' && value !== 'marginal') {
    throw new Error(`--grid-kind must be "average" or "marginal" (got "${raw}")`);
  }
  return value;
}

/**
 * Class C input. Undefined when nothing was declared, which means no derived
 * carbon is reported anywhere. Throws on an unknown zone so a typo cannot
 * silently drop a column the operator asked for.
 */
function gridFromConfig(config: Config): GridIntensity | undefined {
  return resolveGridIntensity({
    ...(config.carbon.grid_intensity_g_per_kwh !== undefined
      ? { gramsPerKwh: config.carbon.grid_intensity_g_per_kwh }
      : {}),
    ...(config.carbon.grid_zone ? { zone: config.carbon.grid_zone } : {}),
    kind: config.carbon.grid_kind,
    ...(config.carbon.grid_source ? { source: config.carbon.grid_source } : {}),
    ...(config.carbon.grid_year !== undefined ? { year: config.carbon.grid_year } : {}),
  });
}

async function buildConfig(args: Args): Promise<Config> {
  let config = one(args, 'config') ? await loadConfigFile(one(args, 'config')!) : defaultConfig();

  const runs = one(args, 'runs');
  const warmups = one(args, 'warmups');
  const out = one(args, 'out');
  const gridIntensity = one(args, 'grid-intensity');
  const gridZone = one(args, 'grid-zone');
  const gridKind = one(args, 'grid-kind');
  const gridSource = one(args, 'grid-source');
  const gridYear = one(args, 'grid-year');

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
      ...(one(args, 'viewport') ? { viewport: parseViewportFlag(one(args, 'viewport')!) } : {}),
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
    co2: {
      ...config.co2,
      ...(has(args, 'green-hosting') ? { check_green_hosting: true } : {}),
    },
    network: {
      ...config.network,
      ...(has(args, 'public-only') ? { public_only: true } : {}),
    },
    output: { ...config.output, ...(out ? { directory: out } : {}) },
    carbon: {
      ...config.carbon,
      ...(gridIntensity
        ? { grid_intensity_g_per_kwh: parseNumberFlag('--grid-intensity', gridIntensity) }
        : {}),
      ...(gridZone ? { grid_zone: gridZone } : {}),
      ...(gridKind ? { grid_kind: parseGridKind(gridKind) } : {}),
      ...(gridSource ? { grid_source: gridSource } : {}),
      ...(gridYear ? { grid_year: parseIntegerFlag('--grid-year', gridYear) } : {}),
    },
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
async function probePowerCounters(): Promise<FirefoxProbe & { durationMs: number }> {
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
    const selection = adapter.powerSelection();
    return {
      samples: probe?.sampleCount ?? 0,
      ...(probe?.totalJoules !== undefined ? { joules: probe.totalJoules, windowMs: probe.durationMs } : {}),
      counters: adapter.counterNames(),
      ...(selection && (probe?.sampleCount ?? 0) > 0 ? { scope: selection.scope } : {}),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { samples: 0, counters: [], durationMs: Date.now() - started, error: firstLine((err as Error).message) };
  }
}

const firstLine = (m: string) => m.split('\n')[0]!.slice(0, 300);

/** Host facts plus a real Firefox probe, judged into one verdict. */
async function runEnergyProbe(): Promise<EnergyProbe> {
  const facts = await collectHostFacts();
  const firefoxProbe = await probePowerCounters();
  const { durationMs: _total, ...firefoxFacts } = firefoxProbe;
  return { ...facts, firefox: firefoxFacts, ...judgeEnergy(facts, firefoxFacts) };
}

async function cmdDoctor(args: Args): Promise<number> {
  // Machine-readable energy verdict, for CI and for scripting a local setup.
  if (has(args, 'json')) {
    console.log(JSON.stringify(await runEnergyProbe(), null, 2));
    return 0;
  }
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
  lines.push('Energy measurement');
  // Platform support is not proof: virtual machines expose counters that never
  // emit a sample, and Linux needs a kernel setting. So always run a real
  // short profile and judge the result.
  const probe = await runEnergyProbe();
  if (probe.virtualised !== undefined) {
    (probe.virtualised ? warn : ok)(
      probe.virtualised ? `Virtual machine: ${probe.hypervisor ?? 'yes'}` : 'Physical machine (no hypervisor detected)',
    );
  }
  if (probe.linux) {
    const l = probe.linux;
    (l.pmu ? ok : warn)(
      l.pmu ? `RAPL power events: ${l.events.join(', ') || 'present'}` : 'RAPL power events: not exposed',
    );
    if (l.pmu) {
      ((l.paranoid ?? 99) <= 0 ? ok : warn)(`kernel.perf_event_paranoid = ${l.paranoid ?? 'unreadable'} (Firefox needs <= 0)`);
    }
  }
  if (probe.firefox?.error) {
    warn(`Firefox probe could not run: ${probe.firefox.error}`);
  } else if (probe.firefox) {
    (probe.firefox.samples > 0 ? ok : warn)(
      `Firefox power samples: ${probe.firefox.samples}` +
        (probe.firefox.counters.length ? ` (counters: ${probe.firefox.counters.join(', ')})` : ' (no power counters)'),
    );
  }
  const verdictLabel = { energy: 'CAN measure energy', fixable: 'can measure energy after one fix', unavailable: 'CANNOT measure energy', untested: 'not tested' }[probe.verdict];
  lines.push(`  => This host ${verdictLabel}. ${probe.reason}`);
  for (const step of probe.nextSteps) lines.push(`       - ${step}`);
  lines.push('');
  lines.push('Other adapters');

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
  scope?: FirefoxProbe['scope'],
): Promise<BenchmarkResult['capabilities']> {
  // The run itself is the probe: energyAvailable means its own profile had
  // samples. Host facts explain why not, and what would fix it.
  const facts = await collectHostFacts();
  const check = judgeEnergy(facts, {
    samples: energyAvailable ? 1 : 0,
    counters: [],
    ...(scope ? { scope } : {}),
  });
  const c = describeCapabilities({
    powerSamplesObserved: energyAvailable,
    platform: process.platform,
    architecture: process.arch,
    ...(facts.virtualised !== undefined ? { virtualised: facts.virtualised } : {}),
    reason: check.reason,
  });
  return {
    tier: c.tier,
    summary: c.summary,
    unavailable: c.unavailable,
    energyCheck: {
      verdict: check.verdict,
      reason: energyAvailable ? `Energy was measured: ${scopeText(scope)}.` : check.reason,
      nextSteps: check.nextSteps,
      ...(facts.hypervisor ? { hypervisor: facts.hypervisor } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

/** What the measured energy covered, read from the first run that has energy. */
function energyScopeOf(steps: StepResult[]): FirefoxProbe['scope'] {
  const scope = steps.find((s) => s.energy?.raw.totalJoules !== undefined)?.energy?.raw.measurementScope;
  return scope === 'process' || scope === 'cpu-package' || scope === 'system' ? scope : undefined;
}

function scopeText(scope: FirefoxProbe['scope']): string {
  return scope === 'process'
    ? 'per-process Firefox energy'
    : scope === 'cpu-package'
      ? 'the whole CPU package, for every process on the machine'
      : scope === 'system'
        ? 'the whole platform, for every process on the machine'
        : 'Firefox power counters';
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

function printSummary(steps: StepResult[], grid?: GridIntensity): void {
  const byStep = groupByStep(steps);
  const failed = failedSteps(steps);
  if (failed.length > 0) {
    console.log(`\n${failed.length} URL(s) could not be measured:`);
    for (const f of failed) console.log(`  ${f.step}\n    ${readableFailure(f.reason)}`);
  }
  if (byStep.size === 0) {
    console.log('\nNo measured runs recorded.');
    return;
  }
  const carbonHead = grid ? '  Energy CO2e' : '';
  console.log(`\nScenario                         Transfer     CO2.js       Energy${carbonHead}  Resolved`);
  console.log('-'.repeat(grid ? 90 : 77));
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
    // Class C inherits the resolution of the energy it derives from. Printing a
    // figure for an unresolved step would turn measurement noise into a
    // carbon claim, and the median can be negative.
    const carbon = grid
      ? (energy.count > 0 && res.resolved
          ? `${formatMicrograms(energyCarbon(joulesToMilliwattHours(energy.median), grid).micrograms)} µg`.padStart(13)
          : `${'—'}`.padStart(13))
      : '';
    const flag = energy.count === 0 ? '    —' : res.resolved ? '  yes' : '   NO';
    if (energy.count > 0 && !res.resolved) unresolved++;
    console.log(`${name}${kb}${mg}${mwh}${carbon}${flag}`);
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

  if (grid) {
    const where =
      grid.zoneName && grid.zone ? `${grid.zoneName} (${grid.zone})` : (grid.zone ?? 'zone unspecified');
    console.log(
      '\n"Energy CO2e" is derived from incremental client energy, not from the CO2.js estimate.\n' +
        `Grid: ${grid.gramsPerKwh} gCO2e/kWh, ${where}, ${grid.kind} intensity` +
        `${grid.year !== undefined ? `, ${grid.year}` : ''}.\n` +
        `Source: ${grid.source}.\n` +
        'It is blank where the energy it would derive from is below the resolution of this setup.',
    );
  }
}

async function cmdMeasure(args: Args): Promise<number> {
  const urls = args._.slice(1);
  if (urls.length === 0) {
    console.error('measure requires at least one URL');
    return 1;
  }
  const config = await buildConfig(args);
  // Fail on a bad grid declaration before spending a session measuring.
  const grid = gridFromConfig(config);
  const crux = cruxFromArgs(args, urls[0]!);
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
    capabilities: await capabilitiesFor(outcome.energyAvailable, energyScopeOf(outcome.steps)),
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
    ...(grid ? { gridIntensity: grid } : {}),
    warnings: outcome.warnings,
  };

  await attachLighthouse(args, config, result, urls, 'measure');
  await attachCrux(result, crux);
  await attachWebnrg(args, result, urls, 'measure');
  const base = await writeOutputs(result, config);
  printSummary(outcome.steps, grid);
  if (result.lighthouse) printLighthouse(result.lighthouse);
  if (result.crux) printCrux(result.crux);
  if (result.webnrg) printWebnrg(result.webnrg);
  for (const w of result.warnings) console.log(`\nwarning: ${w}`);
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
  const grid = gridFromConfig(config);
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
    capabilities: await capabilitiesFor(outcome.energyAvailable, energyScopeOf(outcome.steps)),
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
    ...(grid ? { gridIntensity: grid } : {}),
    warnings: outcome.warnings,
  };

  const base = await writeOutputs(result, config);
  printSummary(outcome.steps, grid);
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
  const grid = gridFromConfig(config);
  const crux = cruxFromArgs(args, start);
  const outcome = await crawl({
    config,
    startUrl: start,
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(70)}`),
  });
  process.stderr.write('\n');

  const result: BenchmarkResult = {
    schemaVersion: SCHEMA_VERSION,
    session: { id: newSessionId(), startedAt: new Date().toISOString(), mode: 'crawl' },
    capabilities: await capabilitiesFor(outcome.energyAvailable, energyScopeOf(outcome.steps)),
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
    ...(grid ? { gridIntensity: grid } : {}),
    warnings: [
      ...outcome.warnings,
      'Crawl mode is for discovery and broad assessment. It is not a controlled regression workload; use journey mode for A/B comparisons.',
    ],
  };

  await attachLighthouse(args, config, result, [start], 'crawl');
  await attachCrux(result, crux);
  await attachWebnrg(args, result, [start], 'crawl');
  const base = await writeOutputs(result, config);
  printSummary(outcome.steps, grid);
  if (result.lighthouse) printLighthouse(result.lighthouse);
  if (result.crux) printCrux(result.crux);
  if (result.webnrg) printWebnrg(result.webnrg);
  console.log(`\nWrote ${base}.{json,csv,html}`);
  return 0;
}

interface LighthouseArgs {
  runs: number;
  categories: ReturnType<typeof parseCategories>;
  formFactor: FormFactor;
  /** Audit only the heaviest N pages; undefined means every page. */
  top?: number;
  reportsDir?: string;
}

function lighthouseArgs(args: Args, config: Config, mode: 'measure' | 'crawl' = 'measure'): LighthouseArgs {
  const runs = Number.parseInt(one(args, 'lighthouse-runs') ?? '3', 10);
  // A crawl can reach hundreds of pages, so it always has a limit; a list
  // is audited in full unless --lighthouse-top says otherwise.
  const topRaw = one(args, 'lighthouse-top') ?? (mode === 'crawl' ? '10' : 'all');
  const top = topRaw === 'all' ? undefined : Number.parseInt(topRaw, 10);
  const ff = one(args, 'lighthouse-form-factor');
  if (ff && ff !== 'mobile' && ff !== 'desktop') {
    throw new Error(`--lighthouse-form-factor must be mobile or desktop (got "${ff}")`);
  }
  const reportsDir = one(args, 'lighthouse-reports');
  return {
    runs: Number.isFinite(runs) && runs >= 1 ? Math.min(runs, 9) : 3,
    categories: parseCategories(one(args, 'lighthouse-categories')),
    formFactor: (ff as FormFactor | undefined) ?? formFactorFor(config.browser.viewport),
    ...(top === undefined ? {} : { top: Number.isFinite(top) && top >= 0 ? top : 10 }),
    ...(reportsDir ? { reportsDir: resolve(reportsDir) } : {}),
  };
}

/**
 * Run Lighthouse after the Firefox session and attach its summary.
 *
 * A Lighthouse failure never discards the Firefox results it follows: it is
 * recorded as a warning and the scan still writes everything else.
 */
async function attachLighthouse(
  args: Args,
  config: Config,
  result: BenchmarkResult,
  requested: string[],
  mode: 'measure' | 'crawl',
): Promise<void> {
  if (!has(args, 'lighthouse')) return;
  const opts = lighthouseArgs(args, config, mode);
  const { urls, skipped, blocked } = pickLighthouseUrls(result.scenarios, requested, mode, opts.top);
  if (skipped.length) {
    result.warnings.push(
      `Lighthouse skipped ${skipped.length} URL(s) that are file downloads rather than pages.`,
    );
  }
  if (blocked.length) {
    result.warnings.push(
      `Lighthouse skipped ${blocked.length} URL(s) that lead to private or local addresses.`,
    );
  }
  if (urls.length === 0) return;
  try {
    result.lighthouse = await runLighthouse({
      urls,
      runs: opts.runs,
      categories: opts.categories,
      formFactor: opts.formFactor,
      ...(opts.reportsDir ? { reportsDir: opts.reportsDir } : {}),
      publicOnly: config.network.public_only,
      onProgress: (m) => process.stderr.write(`\r${m.padEnd(60)}`),
    });
    process.stderr.write('\n');
  } catch (err) {
    process.stderr.write('\n');
    result.warnings.push(`Lighthouse did not run: ${(err as Error).message}`);
  }
}

function printLighthouse(lh: LighthouseSummary): void {
  console.log(
    `\nLighthouse ${lh.version} — ${lh.browser ?? 'Chromium'}, ${lh.formFactor}, ${lh.throttling}; ` +
      `median of ${lh.runsPerUrl} run(s)`,
  );
  console.log('Scenario                        Perf     LCP     TBT    CLS  Main thread');
  console.log('------------------------------------------------------------------------');
  const sec = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
  for (const r of lh.results) {
    const name = (r.requestedUrl.length > 30 ? `...${r.requestedUrl.slice(-27)}` : r.requestedUrl).padEnd(30);
    if (r.runs === 0) {
      console.log(`${name}  failed: ${r.error ?? 'no report'}`);
      continue;
    }
    const perf = r.scores.performance;
    console.log(
      name +
        String(perf ?? '—').padStart(6) +
        sec(r.metrics.lcpMs).padStart(8) +
        `${r.metrics.tbtMs ?? '—'} ms`.padStart(8) +
        String(r.metrics.cls ?? '—').padStart(7) +
        sec(r.work.mainThreadMs).padStart(13) +
        (perf !== undefined ? `  (${scoreRating(perf)})` : ''),
    );
  }

  const common = sitewideRecommendations(lh.results.filter((r) => r.runs > 0)).slice(0, 8);
  if (common.length) {
    console.log(`\nTop recommendations (pages affected of ${lh.results.length}):`);
    for (const c of common) {
      const savings = [
        c.medianSavingsMs ? `~${(c.medianSavingsMs / 1000).toFixed(1)} s` : '',
        c.medianSavingsBytes ? `~${Math.round(c.medianSavingsBytes / 1024)} KB` : '',
      ].filter(Boolean).join(', ');
      console.log(`  ${String(c.pages).padStart(3)}  ${c.title}${savings ? `  (${savings} per page)` : ''}`);
    }
  }
  console.log(
    '\nLighthouse runs Chromium under simulated throttling. Its scores describe lab load\n' +
      'performance, not Firefox and not energy; they are reported beside, never combined.',
  );
}

const intFlag = (args: Args, key: string, fallback: number, min: number, max: number): number => {
  const raw = one(args, key);
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/**
 * Add webNRG lab figures for a few pages, after the Firefox session and
 * Lighthouse have finished. Never fails the scan: problems become warnings.
 */
async function attachWebnrg(
  args: Args,
  result: BenchmarkResult,
  requested: string[],
  mode: 'measure' | 'crawl',
): Promise<void> {
  const lookupOnly = has(args, 'webnrg-lookup-only');
  if (!has(args, 'webnrg') && !lookupOnly) return;
  const top = intFlag(args, 'webnrg-top', 3, 1, 10);
  // A list: the pages as listed. A crawl: the heaviest pages found.
  const urls =
    mode === 'measure'
      ? pickLighthouseUrls(result.scenarios, requested, 'measure', undefined).urls.slice(0, top)
      : pickLighthouseUrls(result.scenarios, requested, 'crawl', top).urls;
  if (urls.length === 0) return;
  if (!lookupOnly) {
    process.stderr.write(`webNRG: checking ${urls.length} page(s) with green-coding.io; its results are public.\n`);
  }
  try {
    result.webnrg = await runWebnrg(urls, {
      submit: !lookupOnly,
      waitMinutes: intFlag(args, 'webnrg-wait', 0, 0, 120),
      onProgress: (m) => process.stderr.write(`\r${m.slice(0, 90).padEnd(90)}`),
    });
    process.stderr.write('\n');
  } catch (err) {
    result.warnings.push(`webNRG did not run: ${(err as Error).message}`);
  }
}

function printWebnrg(summary: WebnrgSummary): void {
  console.log(`\nwebNRG lab check — Firefox on Green Coding's machine${summary.machine ? ` (${summary.machine})` : ''}`);
  console.log('Page                                    Energy     Power  Transfer  Grades    Status');
  console.log('---------------------------------------------------------------------------------------');
  const f = (v: number | undefined, d: number, u: string) => (v === undefined ? '—' : `${v.toFixed(d)} ${u}`);
  for (const p of summary.pages) {
    const name = (p.page.length > 38 ? `...${p.page.slice(-35)}` : p.page).padEnd(38);
    const m = p.metrics;
    const status =
      p.status === 'reused' ? `reused ${p.measuredAt?.slice(0, 10) ?? ''}`
        : p.status === 'submitted' ? `requested (job ${p.jobId})`
          : p.status === 'failed' ? `failed: ${p.error ?? ''}`
            : p.status === 'not-requested' ? 'no recent result' : p.status;
    console.log(
      name +
        f(m?.cpuEnergyMwh, 2, 'mWh').padStart(10) +
        f(m?.cpuPowerW, 2, 'W').padStart(9) +
        f(m?.transferKb, 0, 'kB').padStart(10) +
        `  ${m ? `${m.renderingGrade ?? '—'} / ${m.transferGrade ?? '—'}` : ''}`.padEnd(10) +
        status,
    );
  }
  console.log(
    '\nCPU package energy for the page load plus 5 s idle on a dedicated machine, no idle\n' +
      'subtraction. A different boundary from this scanner: shown beside, never combined.',
  );
  for (const p of summary.pages) {
    if (p.runId || p.jobId !== undefined) console.log(`  ${p.page}\n    ${p.statsUrl ?? p.detailsUrl}`);
  }
}

/** webNRG on its own: look up or request lab figures for these URLs. */
async function cmdWebnrg(args: Args): Promise<number> {
  const urls = args._.slice(1);
  if (urls.length === 0) {
    console.error('webnrg requires at least one URL');
    return 1;
  }
  const config = await buildConfig(args);
  const lookupOnly = has(args, 'lookup-only');
  if (!lookupOnly) process.stderr.write(`webNRG: checking ${urls.length} page(s) with green-coding.io; its results are public.\n`);
  const summary = await runWebnrg(urls, {
    submit: !lookupOnly,
    waitMinutes: intFlag(args, 'wait', 30, 0, 120),
    onProgress: (m) => process.stderr.write(`\r${m.slice(0, 90).padEnd(90)}`),
  });
  process.stderr.write('\n');
  const dir = resolve(config.output.directory);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `webnrg-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(summary, null, 2));
  printWebnrg(summary);
  console.log(`\nWrote ${file}`);
  return 0;
}

/**
 * Wait for webNRG measurements requested earlier and record their figures.
 * Takes a scan result (its webnrg section is updated in place) or a webNRG
 * summary on its own.
 */
async function cmdWebnrgCollect(args: Args): Promise<number> {
  const file = args._[1];
  if (!file) {
    console.error('webnrg-collect requires a result or webNRG JSON file');
    return 1;
  }
  const doc = JSON.parse(await readFile(file, 'utf8')) as BenchmarkResult | WebnrgSummary;
  const summary = 'tool' in doc && doc.tool === 'webnrg' ? doc : (doc as BenchmarkResult).webnrg;
  if (!summary) {
    console.error(`${file} has no webNRG section`);
    return 1;
  }
  await collectWebnrg(summary, {
    waitMinutes: intFlag(args, 'wait', 30, 0, 120),
    onProgress: (m) => process.stderr.write(`\r${m.slice(0, 90).padEnd(90)}`),
  });
  process.stderr.write('\n');
  await writeFile(file, JSON.stringify(doc, null, 2));
  const md = one(args, 'markdown');
  if (md) await writeFile(md, webnrgMarkdown(summary, { title: '**Lab check: webNRG results**' }) + '\n');
  printWebnrg(summary);
  return 0;
}

/** Lighthouse on its own, without a Firefox run. */
async function cmdLighthouse(args: Args): Promise<number> {
  const urls = args._.slice(1);
  if (urls.length === 0) {
    console.error('lighthouse requires at least one URL');
    return 1;
  }
  const config = await buildConfig(args);
  const opts = lighthouseArgs(args, config);
  const summary = await runLighthouse({
    urls,
    runs: opts.runs,
    categories: opts.categories,
    formFactor: opts.formFactor,
    ...(opts.reportsDir ? { reportsDir: opts.reportsDir } : {}),
    publicOnly: config.network.public_only,
    onProgress: (m) => process.stderr.write(`\r${m.padEnd(60)}`),
  });
  process.stderr.write('\n');
  const dir = resolve(config.output.directory);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `lighthouse-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(summary, null, 2));
  printLighthouse(summary);
  console.log(`\nWrote ${file}`);
  return summary.results.some((r) => r.runs > 0) ? 0 : 1;
}

/**
 * Resolve the CrUX options for a command, or undefined when not requested.
 *
 * Called before Firefox starts, so a missing key or a non-public target fails in
 * a second rather than after a ten-minute run.
 */
function cruxFromArgs(args: Args, target: string): CruxRequest | undefined {
  if (!has(args, 'crux')) return undefined;
  const apiKey = cruxApiKey(one(args, 'crux-key'));
  // Refuses private, local and development targets before anything is launched:
  // the query carries the URL to Google.
  cruxTarget(target);
  return {
    target,
    scope: has(args, 'crux-url') ? 'url' : 'origin',
    formFactor: parseCruxFormFactor(one(args, 'crux-form-factor')),
    apiKey,
  };
}

function parseCruxFormFactor(value: string | undefined): CruxFormFactorFilter {
  switch ((value ?? 'all').toLowerCase()) {
    case 'all':
      return 'ALL';
    case 'phone':
      return 'PHONE';
    case 'desktop':
      return 'DESKTOP';
    case 'tablet':
      return 'TABLET';
    default:
      throw new Error(`--crux-form-factor must be all, phone, desktop or tablet (got ${value})`);
  }
}

async function attachCrux(
  result: BenchmarkResult,
  request: CruxRequest | undefined,
): Promise<void> {
  if (!request) return;
  result.crux = await fetchCrux(request);
}

function printCrux(crux: CruxResult): void {
  console.log('\nField data (CrUX)');
  console.log(describeCrux(crux));
  if (crux.status !== 'ok' || !crux.record) {
    console.log(
      `  ${crux.status === 'no-data' ? 'No data' : 'Unavailable'}: ${crux.detail ?? 'no record returned'}`,
    );
    return;
  }
  for (const name of CRUX_METRICS) {
    const metric = crux.record.metrics[name];
    if (!metric) continue;
    console.log(
      `  ${CRUX_LABELS[name].padEnd(26)}${formatCruxValue(name, metric.p75).padStart(8)}   ` +
        `good ${formatCruxShare(metric.band.good).padStart(4)}  ` +
        `needs improvement ${formatCruxShare(metric.band.needsImprovement).padStart(4)}  ` +
        `poor ${formatCruxShare(metric.band.poor).padStart(4)}`,
    );
  }
  console.log(
    '\nField data is real Chrome users over 28 days. It describes the live site, not a\n' +
      'change made today, and it is not a Lighthouse score; the two are never combined.',
  );
}

/** CrUX field data on its own, with no browser and no measurement. */
async function cmdCrux(args: Args): Promise<number> {
  const target = args._[1];
  if (!target) {
    console.error('crux requires a URL');
    return 1;
  }
  const crux = await fetchCrux({
    target,
    scope: has(args, 'crux-url') ? 'url' : 'origin',
    formFactor: parseCruxFormFactor(one(args, 'crux-form-factor')),
    apiKey: cruxApiKey(one(args, 'crux-key')),
  });
  printCrux(crux);
  // No record is a real answer about a low-traffic URL, not a failed command.
  return crux.status === 'error' ? 1 : 0;
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
  const grid = gridFromConfig(config);
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
    ...(grid ? { gridIntensity: grid } : {}),
    warnings: [...new Set(warnings)],
  };

  const base = await writeOutputs(result, config);

  console.log(
    `\nScenario                    ${labelA.padEnd(12)}${labelB.padEnd(12)}Change${grid ? '   Δ CO2e' : ''}`,
  );
  console.log('-'.repeat(grid ? 69 : 53));
  const stepsA = groupByStep(perTarget.a);
  const stepsB = groupByStep(perTarget.b);
  for (const [step, runsA] of stepsA) {
    const runsB = stepsB.get(step) ?? [];
    const energyA = runsA.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const energyB = runsB.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    if (energyA.length === 0 || energyB.length === 0) continue;
    const cmp = compare(energyA, energyB);
    const mwhA = joulesToMilliwattHours(cmp.a.median);
    const mwhB = joulesToMilliwattHours(cmp.b.median);
    const mA = mwhA.toFixed(3);
    const mB = mwhB.toFixed(3);
    const pct = Number.isFinite(cmp.percentDifference) ? `${cmp.percentDifference.toFixed(1)}%` : '—';
    // Class C: the useful A/B figure is the change in derived carbon, and it is
    // only meaningful when BOTH sides resolve against their own spread.
    const carbon = grid
      ? (resolution(energyA).resolved && resolution(energyB).resolved
          ? `${formatMicrograms(energyCarbon(mwhB - mwhA, grid).micrograms)} µg`.padStart(12)
          : `${'—'}`.padStart(12))
      : '';
    console.log(
      `${step.slice(0, 26).padEnd(28)}${`${mA} mWh`.padEnd(12)}${`${mB} mWh`.padEnd(12)}${pct}${carbon}`,
    );
    if (cmp.qualification) console.log(`   note: ${cmp.qualification}`);
  }
  if (grid) {
    console.log(
      '\nΔ CO2e is the change in carbon derived from incremental energy, not a CO2.js figure.\n' +
        `Grid: ${describeGrid(grid)}\n` +
        'It is blank where either side is below the resolution of this setup.',
    );
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
  const grid = gridFromConfig(config);
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
    ...(grid ? { gridIntensity: grid } : {}),
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
  const titleFile = one(args, 'title-file');
  const title = titleFile ? await readFile(resolve(titleFile), 'utf8') : '';
  const request = parseScanRequest(body, title);
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
  let twig;
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
    // Drupal only: maps rendered markup back to Twig templates when the target
    // has debug enabled. Silently reports "not enabled" otherwise.
    twig = await collectTwigTemplates(page);

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

  if (twig?.enabled && twig.templates.length > 0) {
    console.log('Twig templates (Drupal)');
    console.log('  template                        renders   owns   within');
    for (const t of twig.templates.slice(0, 10)) {
      console.log(
        '  ' + t.name.slice(0, 30).padEnd(32) +
          String(t.occurrences).padStart(5) +
          String(t.nodesExclusive).padStart(8) +
          String(t.nodesInclusive).padStart(9),
      );
    }
    console.log(
      '\n  "owns" excludes markup produced by nested templates, so it points at the\n' +
        '  template actually responsible. "within" includes everything inside it.',
    );
    console.log(`  ${twig.note}\n`);
  } else if (twig) {
    console.log(`Twig templates: not available. ${twig.note}\n`);
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
  printSummary(result.scenarios, result.gridIntensity);
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
      case 'doctor': return await cmdDoctor(args);
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
      case 'lighthouse': return await cmdLighthouse(args);
      case 'crux': return await cmdCrux(args);
      case 'webnrg': return await cmdWebnrg(args);
      case 'webnrg-collect': return await cmdWebnrgCollect(args);
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
      console.error(`Error: ${friendlyError(e.message)}`);
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
