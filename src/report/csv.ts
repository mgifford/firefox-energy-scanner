import type { BenchmarkResult, StepResult } from '../core/types.js';

const COLUMNS = [
  'session_id', 'target', 'scenario', 'step', 'run', 'warmup', 'url',
  'duration_ms', 'ttfb_ms', 'dcl_ms', 'load_ms',
  'requests', 'transfer_bytes', 'third_party_requests', 'third_party_bytes',
  'co2_model', 'co2_g', 'co2_device_g',
  'raw_joules', 'baseline_watts', 'estimated_idle_joules', 'incremental_joules',
  'energy_scope', 'energy_type', 'energy_adapter', 'energy_samples',
  'firefox_version', 'playwright_version', 'co2js_version',
  'os', 'architecture', 'headed', 'cache_mode', 'on_battery', 'valid',
] as const;

/** RFC4180-style escaping. */
function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(result: BenchmarkResult): string {
  const env = result.environment;
  const cacheMode = (result.configuration as { benchmark?: { cache_mode?: string } })?.benchmark?.cache_mode;
  const lines: string[] = [COLUMNS.join(',')];

  for (const s of result.scenarios) {
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      session_id: result.session.id,
      target: result.target?.label ?? result.target?.url ?? '',
      scenario: s.scenario,
      step: s.step,
      run: s.run,
      warmup: s.warmup,
      url: s.url,
      duration_ms: round(s.timing.durationMs),
      ttfb_ms: round(s.timing.ttfbMs),
      dcl_ms: round(s.timing.domContentLoadedMs),
      load_ms: round(s.timing.loadMs),
      requests: s.network?.requests,
      transfer_bytes: s.network?.transferBytes,
      third_party_requests: s.network?.thirdPartyRequests,
      third_party_bytes: s.network?.thirdPartyBytes,
      co2_model: s.co2?.model,
      co2_g: s.co2?.estimatedGrams,
      co2_device_g: s.co2?.consumerDeviceGrams,
      raw_joules: round(s.energy?.raw.totalJoules, 6),
      baseline_watts: round(s.energy?.baselineWatts, 6),
      estimated_idle_joules: round(s.energy?.estimatedIdleJoules, 6),
      incremental_joules: round(s.energy?.incrementalJoules, 6),
      energy_scope: s.energy?.raw.measurementScope,
      energy_type: s.energy?.raw.measurementType,
      energy_adapter: s.energy?.raw.adapterId,
      energy_samples: s.energy?.raw.sampleCount,
      firefox_version: env.firefoxVersion,
      playwright_version: env.playwrightVersion,
      co2js_version: env.co2jsVersion,
      os: env.os,
      architecture: env.architecture,
      headed: env.headed,
      cache_mode: cacheMode,
      on_battery: env.onBattery,
      valid: s.valid,
    };
    lines.push(COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

function round(v: number | undefined, digits = 3): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Group measured (non-warmup) runs by step name. */
export function groupByStep(steps: StepResult[]): Map<string, StepResult[]> {
  const map = new Map<string, StepResult[]>();
  for (const s of steps) {
    if (s.warmup) continue;
    const list = map.get(s.step) ?? [];
    list.push(s);
    map.set(s.step, list);
  }
  return map;
}
