import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { BenchmarkResult, StepResult } from '../core/types.js';
import { summarize, resolution } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';

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
}

export interface IndexEntry {
  id: string;
  file: string;
  timestamp: string;
  mode: string;
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
  scenarios: IndexScenario[];
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
  for (const [step, runs] of byStep) {
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

    out.push({
      step,
      ...(runs[0]?.url ? { url: runs[0].url } : {}),
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
  const energyAvailable = result.scenarios.some(
    (s) => s.energy?.raw.totalJoules !== undefined,
  );

  return {
    id: result.session.id,
    file,
    timestamp: env.timestamp,
    mode: result.session.mode,
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
            `No power counters on ${env.os}/${env.architecture}. Network, CO2.js and timing ` +
            'metrics are valid; energy was not measured.',
        }
      : {}),
    scenarios: summarizeScenarios(result.scenarios),
    warnings: result.warnings,
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
