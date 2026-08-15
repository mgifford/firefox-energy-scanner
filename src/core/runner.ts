import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type {
  StepResult,
  EnergyResult,
  NetworkSummary,
  TimingResult,
} from './types.js';
import { BrowserSession, waitForStablePage, readTimings } from '../collect/session.js';
import { estimateCo2 } from './co2.js';
import { applyBaseline, deriveBaseline, type Baseline } from './baseline.js';
import type { JourneyDefinition } from './journey.js';
import { loginDrupal, readDrupalCredentials } from '../drupal/helpers.js';

export interface StepRecord {
  label: string;
  url?: string;
  startedAt: number;
  endedAt: number;
  timing: TimingResult;
  network: NetworkSummary;
  valid: boolean;
  warnings: string[];
}

/**
 * Executes measured steps within one browser session.
 *
 * Energy is resolved after the session closes, because the Gecko profile is
 * only written at browser shutdown (see docs/decision-record.md TDR-002).
 */
export class StepRunner {
  private records: StepRecord[] = [];

  constructor(
    private readonly session: BrowserSession,
    private readonly config: Config,
  ) {}

  /** Measure a named block of work. */
  async measure(label: string, fn: () => Promise<void>): Promise<void> {
    const page = this.session.getPage();
    const warnings: string[] = [];
    this.session.beginCollection(page.url());

    const handle = await this.session.energy?.start({ label });
    const startedAt = handle?.startedAt ?? Date.now();

    let valid = true;
    try {
      await fn();
      await waitForStablePage(page, this.config.stability);
    } catch (err) {
      valid = false;
      warnings.push(`Step failed: ${(err as Error).message}`);
    }

    const endedAt = Date.now();
    if (handle) await this.session.energy?.stop(handle);

    const network = this.session.endCollection(true);
    const timing = valid
      ? await readTimings(page, endedAt - startedAt)
      : { durationMs: endedAt - startedAt };

    this.records.push({
      label,
      url: page.url(),
      startedAt,
      endedAt,
      timing,
      network,
      valid,
      warnings,
    });
  }

  getRecords(): StepRecord[] {
    return this.records;
  }
}

export interface RunOptions {
  config: Config;
  baseUrl: string;
  /** Journey to execute, or a list of URLs for simple measurement. */
  journey?: JourneyDefinition;
  urls?: string[];
  scenarioName: string;
  onProgress?: (message: string) => void;
}

export interface RunOutcome {
  steps: StepResult[];
  baseline?: Baseline;
  warnings: string[];
  firefoxVersion: string;
  energyAvailable: boolean;
}

/**
 * Run warmups and measured runs for a journey or URL set.
 *
 * Warmup runs are executed and then discarded: they populate caches and settle
 * JIT/thermal state but must never enter the statistical summary.
 */
export async function runBenchmark(options: RunOptions): Promise<RunOutcome> {
  const { config, baseUrl, scenarioName } = options;
  const warnings: string[] = [];
  const steps: StepResult[] = [];
  const useEnergy = config.energy.adapter !== 'noop';

  const session = await BrowserSession.create(config, useEnergy);
  const firefoxVersion = await session.version();
  let baseline: Baseline | undefined;
  let energyAvailable = false;
  let closed = false;

  try {
    await authenticateIfNeeded(session, config, baseUrl, warnings);

    const runner = new StepRunner(session, config);
    const totalRuns = config.benchmark.warmups + config.benchmark.runs;

    // Idle baseline, captured inside the same session so the browser and
    // environment match the measured workload as closely as possible.
    if (config.energy.baseline && useEnergy) {
      options.onProgress?.('Collecting idle baseline');
      // Discard the browser's startup activity before sampling idle power,
      // otherwise the baseline is inflated and light pages yield negative
      // incremental energy.
      await session.getPage().goto('about:blank');
      if (config.energy.baseline_settle_ms > 0) {
        await session.getPage().waitForTimeout(config.energy.baseline_settle_ms);
      }
      await runner.measure('__baseline__', async () => {
        await session.getPage().waitForTimeout(config.energy.baseline_duration_ms);
      });
    }

    for (let i = 0; i < totalRuns; i++) {
      const warmup = i < config.benchmark.warmups;
      const runIndex = warmup ? i : i - config.benchmark.warmups;
      options.onProgress?.(
        `${warmup ? 'Warmup' : 'Run'} ${runIndex + 1}/${warmup ? config.benchmark.warmups : config.benchmark.runs}`,
      );

      await session.applyCacheMode();
      const label = (name: string) => `${warmup ? 'warmup' : 'run'}:${runIndex}:${name}`;

      if (options.journey) {
        const page = session.getPage();
        await options.journey.run({
          page,
          context: session.getContext(),
          baseUrl,
          env: process.env,
          url: (p: string) => new URL(p, baseUrl).toString(),
          measure: (name, fn) => runner.measure(label(name), fn),
        });
      } else {
        for (const url of options.urls ?? []) {
          await runner.measure(label(url), async () => {
            await session.getPage().goto(url, { waitUntil: 'domcontentloaded' });
          });
        }
      }

      if (config.benchmark.settle_ms > 0) {
        await session.getPage().waitForTimeout(config.benchmark.settle_ms);
      }
    }

    // Capture records before closing, then close so Firefox flushes the
    // profile at shutdown. Energy can only be resolved after that point.
    const records = runner.getRecords();
    await session.close();
    closed = true;

    const energyByLabel = (await session.energy?.finalize()) ?? new Map<string, EnergyResult>();
    energyAvailable = session.energy?.hasPowerData() ?? false;

    if (!energyAvailable && useEnergy) {
      warnings.push(
        'No power counters were found in the Gecko profile. Energy values are unavailable on this platform; timing and network metrics are still valid.',
      );
    }

    const baselineEnergy = energyByLabel.get('__baseline__');
    if (baselineEnergy) baseline = deriveBaseline(baselineEnergy);

    steps.push(
      ...buildStepResults(records, energyByLabel, baseline, config, scenarioName),
    );
  } finally {
    if (!closed) await session.close().catch(() => {});
  }

  return { steps, baseline, warnings, firefoxVersion, energyAvailable };
}

/**
 * Convert raw step records into results, attaching energy and CO2.
 *
 * Exported for testing without a browser.
 */
export function buildStepResults(
  records: StepRecord[],
  energyByLabel: Map<string, EnergyResult>,
  baseline: Baseline | undefined,
  config: Config,
  scenarioName: string,
): StepResult[] {
  const results: StepResult[] = [];

  for (const record of records) {
    if (record.label === '__baseline__') continue;
    const parsed = parseLabel(record.label);
    if (!parsed) continue;

    const energy = energyByLabel.get(record.label);
    const step: StepResult = {
      scenario: scenarioName,
      step: parsed.name,
      run: parsed.run,
      warmup: parsed.warmup,
      ...(record.url ? { url: record.url } : {}),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      timing: record.timing,
      network: record.network,
      valid: record.valid,
      warnings: [...record.warnings],
    };

    if (config.co2.enabled && record.network.transferBytes > 0) {
      step.co2 = estimateCo2(record.network.transferBytes, { model: config.co2.model });
    }

    if (energy) {
      step.energy = applyBaseline(energy, baseline);
      if (step.energy.negativeIncremental) {
        step.warnings.push(
          'Incremental energy is negative: the workload measured below the idle baseline. Treat this run as noisy.',
        );
      }
    }

    results.push(step);
  }

  return results;
}

/** Labels are `warmup|run:<index>:<name>`; name may itself contain colons. */
export function parseLabel(
  label: string,
): { warmup: boolean; run: number; name: string } | undefined {
  const match = /^(warmup|run):(\d+):(.*)$/s.exec(label);
  if (!match) return undefined;
  return {
    warmup: match[1] === 'warmup',
    run: Number.parseInt(match[2]!, 10),
    name: match[3]!,
  };
}

async function authenticateIfNeeded(
  session: BrowserSession,
  config: Config,
  baseUrl: string,
  warnings: string[],
): Promise<void> {
  if (!config.auth || config.auth.type !== 'drupal') return;
  const creds = readDrupalCredentials(
    process.env,
    config.auth.username_env,
    config.auth.password_env,
  );
  if (!creds) {
    warnings.push(
      `Drupal auth requested but ${config.auth.username_env}/${config.auth.password_env} are not set. Continuing unauthenticated.`,
    );
    return;
  }
  await loginDrupal(session.getPage(), {
    baseUrl,
    username: creds.username,
    password: creds.password,
    loginPath: config.auth.login_path,
  });
}

export function newSessionId(): string {
  return randomUUID();
}
