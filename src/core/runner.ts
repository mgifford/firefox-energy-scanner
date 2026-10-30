import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type {
  StepResult,
  EnergyResult,
  NetworkSummary,
  TimingResult,
} from './types.js';
import { BrowserSession, waitForStablePage, readTimings } from '../collect/session.js';
import { estimateCo2, estimateCo2ByDomain, lookupGreenHosting } from './co2.js';
import { localHostReason } from './addresses.js';
import { applyBaseline, deriveBaseline, type Baseline } from './baseline.js';
import type { JourneyDefinition } from './journey.js';
import { loginDrupal, readDrupalCredentials } from '../drupal/helpers.js';
import { collectPageAnatomy, installLcpObserver, readLcp } from '../collect/page-anatomy.js';
import { buildFindings } from '../report/findings.js';
import { describeBlocked, describeStepFailure } from './failures.js';

export interface StepRecord {
  label: string;
  url?: string;
  startedAt: number;
  endedAt: number;
  timing: TimingResult;
  network: NetworkSummary;
  valid: boolean;
  warnings: string[];
  /** Page structure; collected on every host, since it needs no power hardware. */
  anatomy?: import('../core/types.js').AnatomySummary;
  findings?: import('../core/types.js').FindingSummary[];
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
    /** Collecting anatomy walks the whole DOM, so it is opt-in per run. */
    private collectAnatomy = false,
  ) {}

  /** Enable structural collection for subsequent steps. */
  enableAnatomy(): void {
    this.collectAnatomy = true;
  }

  /** Measure a named block of work. */
  async measure(label: string, fn: () => Promise<void>): Promise<void> {
    const page = this.session.getPage();
    const warnings: string[] = [];
    this.session.beginCollection(page.url());

    const handle = await this.session.energy?.start({ label });
    const startedAt = handle?.startedAt ?? Date.now();

    let valid = true;
    let failure: string | undefined;
    try {
      await fn();
      await waitForStablePage(page, this.config.stability);
    } catch (err) {
      valid = false;
      failure = (err as Error).message;
    }
    // In public-only mode the guard may have refused the page itself (the URL
    // or a redirect leads to a private address), or only some of its parts.
    const blockedDocument = this.session.documentBlockReason(failure);
    if (blockedDocument) {
      valid = false;
      warnings.push(describeBlocked(blockedDocument));
    } else if (failure !== undefined) {
      warnings.push(describeStepFailure(failure));
    } else {
      const parts = this.session.blockedInStep();
      if (parts.length > 0) {
        const targets = [...new Set(parts.map((b) => b.target))];
        warnings.push(
          `Blocked ${parts.length} request${parts.length === 1 ? '' : 's'} to private or local addresses ` +
            `(${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ', …' : ''}). ` +
            'The page was measured without them.',
        );
      }
    }

    const endedAt = Date.now();
    if (handle) await this.session.energy?.stop(handle);

    const network = await this.session.endCollection(true);
    const timing = valid
      ? await readTimings(page, endedAt - startedAt)
      : { durationMs: endedAt - startedAt };

    // Page structure needs no power hardware, so it is collected everywhere.
    // Only on the final run per step, to avoid repeating a full DOM walk.
    let anatomy;
    let findings;
    if (valid && this.collectAnatomy) {
      const full = await collectPageAnatomy(page);
      if (full) {
        const lcp = await readLcp(page);
        if (lcp) full.lcpElement = lcp;
        anatomy = {
          domNodes: full.domNodes,
          domDepth: full.domDepth,
          cssRules: full.cssRules,
          cssSelectors: full.cssSelectors,
          scripts: full.scripts,
          images: full.images,
          iframes: full.iframes,
          animatedElements: full.animatedElements,
          heaviestSubtrees: full.heaviestSubtrees,
          ...(full.lcpElement ? { lcpElement: full.lcpElement } : {}),
        };
        findings = buildFindings(full, undefined).map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          evidence: f.evidence,
          action: f.action,
          category: f.category,
        }));
      }
    }

    this.records.push({
      label,
      // After a failed navigation the page is still on the previous URL, so
      // recording it would attribute this step to the wrong page.
      ...(valid ? { url: page.url() } : {}),
      startedAt,
      endedAt,
      timing,
      network,
      valid,
      warnings,
      ...(anatomy ? { anatomy } : {}),
      ...(findings && findings.length > 0 ? { findings } : {}),
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

    // LCP entries are emitted during load, so the observer must be installed
    // before any navigation.
    await installLcpObserver(session.getPage());

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
      // Structure is identical across runs of the same page, so collect it once
      // on the final run rather than repeating a full DOM walk every time.
      if (i === totalRuns - 1) runner.enableAnatomy();
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

    const green = await greenHostingFor(records, config, warnings);
    steps.push(
      ...buildStepResults(records, energyByLabel, baseline, config, scenarioName, green),
    );
  } finally {
    if (!closed) await session.close().catch(() => {});
  }

  return { steps, baseline, warnings, firefoxVersion, energyAvailable };
}

/**
 * Green-hosting status for every domain the measured pages loaded from, when
 * asked for. Runs after Firefox has closed, so the lookups are outside every
 * energy window. Local and private hosts are never sent.
 */
export async function greenHostingFor(
  records: StepRecord[],
  config: Config,
  warnings: string[],
  lookup: (domains: string[]) => Promise<Map<string, boolean>> = lookupGreenHosting,
): Promise<Map<string, boolean> | undefined> {
  if (!config.co2.enabled || !config.co2.check_green_hosting) return undefined;
  const domains = new Set<string>();
  for (const r of records) {
    for (const e of r.network.resources ?? []) {
      if (e.domain && !localHostReason(e.domain)) domains.add(e.domain.toLowerCase());
    }
  }
  if (domains.size === 0) return new Map();
  const green = await lookup([...domains]);
  if (green.size < domains.size) {
    warnings.push(
      `Green hosting is unknown for ${domains.size - green.size} of ${domains.size} domain(s); ` +
        'their bytes are modelled as grid-powered.',
    );
  }
  return green;
}

/** Bytes per lower-cased domain, from a step's resources. */
function bytesByDomain(resources: { domain: string; transferBytes: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of resources) {
    const d = e.domain.toLowerCase();
    out.set(d, (out.get(d) ?? 0) + e.transferBytes);
  }
  return out;
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
  /** Per-domain green hosting; absent means it was not checked. */
  green?: Map<string, boolean>,
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
      ...(record.anatomy ? { anatomy: record.anatomy } : {}),
      ...(record.findings ? { findings: record.findings } : {}),
    };

    if (config.co2.enabled && record.network.transferBytes > 0) {
      step.co2 =
        green && record.network.resources
          ? estimateCo2ByDomain(bytesByDomain(record.network.resources), green, config.co2.model)
          : estimateCo2(record.network.transferBytes, { model: config.co2.model });
    }

    if (energy) {
      step.energy = applyBaseline(energy, baseline);
      if (step.energy.negativeIncremental) {
        step.warnings.push(
          'Incremental energy is negative: the workload measured below the idle baseline. Treat this run as noisy.',
        );
      }
    }

    if ((energy?.sampleCount ?? Infinity) < 100) {
      step.warnings.push(
        `Only ${energy?.sampleCount ?? 0} power samples in this window. Short steps yield few samples and unreliable energy.`,
      );
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
