import type { BenchmarkResult } from '../core/types.js';

/** One row per measured step of an experiment: both sides, the difference and the verdict. */
const COLUMNS = [
  'experiment', 'url', 'kind', 'change', 'applied', 'step', 'runs_baseline', 'runs_variant',
  'energy_median_mwh_baseline', 'energy_median_mwh_variant', 'energy_iqr_mwh_baseline', 'energy_iqr_mwh_variant',
  'energy_difference_mwh', 'energy_difference_percent', 'resolved_baseline', 'resolved_variant', 'verdict', 'indicative',
  'duration_ms_baseline', 'duration_ms_variant', 'transfer_bytes_baseline', 'transfer_bytes_variant', 'seed',
] as const;

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function experimentCsv(result: BenchmarkResult): string {
  const x = result.experiment;
  const lines: string[] = [COLUMNS.join(',')];
  for (const d of x?.differences ?? []) {
    const e = d.energy;
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      experiment: x!.name,
      url: x!.url,
      kind: x!.variant.kind,
      change: x!.description,
      applied: x!.applied.ok,
      step: d.step,
      runs_baseline: d.runs[0],
      runs_variant: d.runs[1],
      energy_median_mwh_baseline: e?.medianMwh[0],
      energy_median_mwh_variant: e?.medianMwh[1],
      energy_iqr_mwh_baseline: e?.iqrMwh[0],
      energy_iqr_mwh_variant: e?.iqrMwh[1],
      energy_difference_mwh: e?.differenceMwh,
      energy_difference_percent: e?.percent,
      resolved_baseline: e?.resolved[0],
      resolved_variant: e?.resolved[1],
      verdict: d.verdict,
      indicative: d.indicative,
      duration_ms_baseline: d.durationMs[0],
      duration_ms_variant: d.durationMs[1],
      transfer_bytes_baseline: d.transferBytes?.[0],
      transfer_bytes_variant: d.transferBytes?.[1],
      seed: x!.seed,
    };
    lines.push(COLUMNS.map((k) => cell(row[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
