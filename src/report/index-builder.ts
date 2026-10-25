import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { BenchmarkResult, StepResult } from '../core/types.js';
import { summarize, resolution } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { isBlocked, isNotAPage, readableFailure } from '../core/failures.js';
import {
  sitewideRecommendations,
  type FormFactor,
  type LighthouseCategory,
  type LighthouseMetrics,
  type LighthouseSummary,
  type LighthouseUrlResult,
  type SitewideRecommendation,
} from '../lighthouse/summary.js';

/**
 * Builds the machine-readable index that the published site reads.
 *
 * The site is static: it fetches this JSON and renders it client-side, so no
 * server is involved. Every row carries the flags needed to read it honestly
 * (resolved, energyAvailable, power state), because a published number without
 * its caveats invites over-reading.
 */

export interface IndexScenario {
  step: string;
  url?: string;
  /** Structural metrics, available regardless of energy hardware. */
  anatomy?: {
    domNodes: number;
    domDepth: number;
    cssSelectors: number;
    scripts: number;
    images: number;
    animatedElements: number;
    heaviestSubtree?: string;
    lcpElement?: string;
  };
  findings?: { severity: string; title: string; action: string }[];
  runs: number;
  transferBytes: number;
  requests: number;
  thirdPartyRequests: number;
  co2Grams?: number;
  co2Model?: string;
  durationMs: number;
  energyMwh?: number;
  energyIqrMwh?: number;
  /** False when the measurement is below the resolution of the setup. */
  resolved: boolean;
  resolutionNote?: string;
  /**
   * True when no measured run succeeded, e.g. the URL is a PDF download.
   * Every metric is then absent rather than describing some other page.
   */
  failed?: boolean;
  /** The URL served a file download (e.g. a PDF) rather than a page. */
  notAPage?: boolean;
  /** The URL, or a redirect from it, leads to a private or local address. */
  blocked?: boolean;
  failureNote?: string;
  /** Lighthouse lab result for this URL, when one was run. */
  lighthouse?: LighthouseIndexSummary;
}

/** What the site shows per URL. The full summary stays in the result file. */
export interface LighthouseIndexSummary {
  scores: Partial<Record<LighthouseCategory, number>>;
  performanceRange?: [number, number];
  runs: number;
  metrics: LighthouseMetrics;
  mainThreadMs?: number;
  totalBytes?: number;
  recommendations: {
    title: string;
    displayValue?: string;
    savingsMs?: number;
    savingsBytes?: number;
    learnMore?: string;
  }[];
  /** Count of failing audits per non-performance category. */
  failing?: Partial<Record<LighthouseCategory, number>>;
  error?: string;
}

export interface IndexEntry {
  id: string;
  file: string;
  timestamp: string;
  mode: string;
  /** What this host could measure. 'structural' means no energy hardware. */
  tier?: 'full' | 'structural';
  tierSummary?: string;
  target?: string;
  targetLabel?: string;
  issue?: number;
  /** True only when power counters actually produced data. */
  energyAvailable: boolean;
  platform: string;
  architecture: string;
  firefoxVersion?: string;
  onBattery?: boolean;
  lowPowerMode?: boolean;
  runnerNote?: string;
  /** Why energy was or was not measured, and the options when it was not. */
  energyCheck?: NonNullable<BenchmarkResult['capabilities']>['energyCheck'];
  scenarios: IndexScenario[];
  /** Run-level Lighthouse context; per-URL results sit on each scenario. */
  lighthouse?: {
    version: string;
    browser?: string;
    formFactor: FormFactor;
    throttling: string;
    runsPerUrl: number;
    categories: LighthouseCategory[];
    benchmarkIndex?: number;
    /** Failures shared by several pages — usually one template-level fix. */
    sitewide: SitewideRecommendation[];
    /** Lighthouse results for URLs that are not scenarios (crawl top-N picks). */
    unmatched?: (LighthouseIndexSummary & { url: string })[];
  };
  warnings: string[];
}

export interface SiteIndex {
  generatedAt: string;
  schemaVersion: number;
  entries: IndexEntry[];
}

function summarizeScenarios(steps: StepResult[]): IndexScenario[] {
  const byStep = new Map<string, StepResult[]>();
  for (const s of steps) {
    if (s.warmup) continue;
    byStep.set(s.step, [...(byStep.get(s.step) ?? []), s]);
  }

  const out: IndexScenario[] = [];
  for (const [step, all] of byStep) {
    // Failed runs describe no page (after a failed navigation the browser is
    // still on the previous one), so they never enter the medians.
    const runs = all.filter((r) => r.valid);
    if (runs.length === 0) {
      out.push({
        step,
        runs: 0,
        transferBytes: 0,
        requests: 0,
        thirdPartyRequests: 0,
        durationMs: 0,
        resolved: false,
        failed: true,
        ...(isNotAPage(all[0]?.warnings[0]) ? { notAPage: true } : {}),
        ...(isBlocked(all[0]?.warnings[0]) ? { blocked: true } : {}),
        failureNote: readableFailure(all[0]?.warnings[0] ?? 'Every measured run failed.'),
      });
      continue;
    }
    const energyValues = runs
      .map((r) => r.energy?.incrementalJoules)
      .filter((v): v is number => v !== undefined);
    const res = resolution(energyValues);
    const energy = summarize(energyValues);
    const bytes = summarize(runs.map((r) => r.network?.transferBytes ?? Number.NaN));
    const reqs = summarize(runs.map((r) => r.network?.requests ?? Number.NaN));
    const third = summarize(runs.map((r) => r.network?.thirdPartyRequests ?? Number.NaN));
    const co2 = summarize(runs.map((r) => r.co2?.estimatedGrams ?? Number.NaN));
    const dur = summarize(runs.map((r) => r.timing.durationMs));

    // Structure is identical across runs, so take it from whichever run has it.
    const withAnatomy = runs.find((r) => r.anatomy);
    const a = withAnatomy?.anatomy;

    out.push({
      step,
      ...(runs[0]?.url ? { url: runs[0].url } : {}),
      ...(a
        ? {
            anatomy: {
              domNodes: a.domNodes,
              domDepth: a.domDepth,
              cssSelectors: a.cssSelectors,
              scripts: a.scripts,
              images: a.images,
              animatedElements: a.animatedElements,
              ...(a.heaviestSubtrees?.[0] ? { heaviestSubtree: a.heaviestSubtrees[0].selector } : {}),
              ...(a.lcpElement ? { lcpElement: a.lcpElement.selector } : {}),
            },
          }
        : {}),
      ...(withAnatomy?.findings?.length
        ? {
            findings: withAnatomy.findings.map((f) => ({
              severity: f.severity,
              title: f.title,
              action: f.action,
            })),
          }
        : {}),
      runs: runs.length,
      transferBytes: Math.round(bytes.median || 0),
      requests: Math.round(reqs.median || 0),
      thirdPartyRequests: Math.round(third.median || 0),
      ...(Number.isFinite(co2.median) ? { co2Grams: co2.median } : {}),
      ...(runs[0]?.co2?.model ? { co2Model: runs[0].co2.model } : {}),
      durationMs: Math.round(dur.median || 0),
      // Energy is only published when it is resolvable; an unresolved value is
      // noise and would be read as a measurement.
      ...(energy.count > 0 && res.resolved
        ? {
            energyMwh: joulesToMilliwattHours(energy.median),
            energyIqrMwh: joulesToMilliwattHours(energy.iqr),
          }
        : {}),
      resolved: res.resolved,
      ...(res.note ? { resolutionNote: res.note } : {}),
    });
  }
  return out;
}

export function toIndexEntry(result: BenchmarkResult, file: string): IndexEntry {
  const env = result.environment;
  const scenarios = summarizeScenarios(result.scenarios);
  const energyAvailable = result.scenarios.some(
    (s) => s.energy?.raw.totalJoules !== undefined,
  );

  return {
    id: result.session.id,
    file,
    timestamp: env.timestamp,
    mode: result.session.mode,
    ...(result.capabilities ? { tier: result.capabilities.tier, tierSummary: result.capabilities.summary } : {}),
    ...(result.target?.url ? { target: result.target.url } : {}),
    ...(result.target?.label ? { targetLabel: result.target.label } : {}),
    energyAvailable,
    platform: env.os,
    architecture: env.architecture,
    ...(env.firefoxVersion ? { firefoxVersion: env.firefoxVersion } : {}),
    ...(env.onBattery !== undefined ? { onBattery: env.onBattery } : {}),
    ...(env.lowPowerMode !== undefined ? { lowPowerMode: env.lowPowerMode } : {}),
    ...(!energyAvailable
      ? {
          runnerNote:
            result.capabilities?.energyCheck?.reason ??
            `No power samples on ${env.os}/${env.architecture}. Network, CO2.js and timing ` +
              'metrics are valid; energy was not measured.',
        }
      : {}),
    ...(result.capabilities?.energyCheck ? { energyCheck: result.capabilities.energyCheck } : {}),
    scenarios,
    ...(result.lighthouse ? { lighthouse: lighthouseEntry(result.lighthouse, scenarios) } : {}),
    warnings: result.warnings,
  };
}

function toLighthouseIndex(r: LighthouseUrlResult): LighthouseIndexSummary {
  const failing: Partial<Record<LighthouseCategory, number>> = {};
  for (const [cat, list] of Object.entries(r.failingAudits) as [LighthouseCategory, unknown[]][]) {
    failing[cat] = list.length;
  }
  return {
    scores: r.scores,
    ...(r.performanceRange ? { performanceRange: r.performanceRange } : {}),
    runs: r.runs,
    metrics: r.metrics,
    ...(r.work.mainThreadMs !== undefined ? { mainThreadMs: r.work.mainThreadMs } : {}),
    ...(r.work.totalBytes !== undefined ? { totalBytes: r.work.totalBytes } : {}),
    recommendations: r.recommendations.slice(0, 10).map((x) => ({
      title: x.title,
      ...(x.displayValue ? { displayValue: x.displayValue } : {}),
      ...(x.savingsMs !== undefined ? { savingsMs: x.savingsMs } : {}),
      ...(x.savingsBytes !== undefined ? { savingsBytes: x.savingsBytes } : {}),
      ...(x.learnMore ? { learnMore: x.learnMore } : {}),
    })),
    ...(Object.keys(failing).length ? { failing } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Attach each Lighthouse result to the scenario for the same URL. */
function lighthouseEntry(
  lh: LighthouseSummary,
  scenarios: IndexScenario[],
): NonNullable<IndexEntry['lighthouse']> {
  const unmatched: (LighthouseIndexSummary & { url: string })[] = [];
  for (const r of lh.results) {
    const s = scenarios.find((x) => x.step === r.requestedUrl);
    if (s) s.lighthouse = toLighthouseIndex(r);
    else unmatched.push({ url: r.requestedUrl, ...toLighthouseIndex(r) });
  }
  return {
    version: lh.version,
    ...(lh.browser ? { browser: lh.browser } : {}),
    formFactor: lh.formFactor,
    throttling: lh.throttling,
    runsPerUrl: lh.runsPerUrl,
    categories: lh.categories,
    ...(lh.benchmarkIndex !== undefined ? { benchmarkIndex: lh.benchmarkIndex } : {}),
    sitewide: sitewideRecommendations(lh.results.filter((r) => r.runs > 0)).slice(0, 12),
    ...(unmatched.length ? { unmatched } : {}),
  };
}

/** Scan a results directory and write the site index. */
export async function buildIndex(
  resultsDir: string,
  outputPath: string,
): Promise<SiteIndex> {
  let files: string[] = [];
  try {
    files = (await readdir(resultsDir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    files = [];
  }

  const entries: IndexEntry[] = [];
  for (const f of files.sort()) {
    try {
      const raw = await readFile(join(resultsDir, f), 'utf8');
      const result = JSON.parse(raw) as BenchmarkResult;
      if (!result.session || !result.environment) continue;
      entries.push(toIndexEntry(result, basename(f)));
    } catch {
      // A malformed result must not break the whole index.
      continue;
    }
  }

  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  const index: SiteIndex = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    entries,
  };

  await mkdir(join(outputPath, '..'), { recursive: true }).catch(() => {});
  await writeFile(outputPath, JSON.stringify(index, null, 2));
  return index;
}
