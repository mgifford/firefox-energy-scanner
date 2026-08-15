import type { EnergyResult, EnergyWithBaseline } from './types.js';

export interface Baseline {
  watts: number;
  durationMs: number;
  samples: number;
  adapterId: string;
}

/**
 * Derive idle baseline power from an idle measurement.
 *
 *   baseline watts = idle joules / idle seconds
 */
export function deriveBaseline(idle: EnergyResult): Baseline | undefined {
  if (idle.totalJoules === undefined || idle.durationMs <= 0) return undefined;
  return {
    watts: idle.totalJoules / (idle.durationMs / 1000),
    durationMs: idle.durationMs,
    samples: idle.sampleCount ?? 0,
    adapterId: idle.adapterId,
  };
}

/**
 * Subtract expected idle energy from a measured workload.
 *
 *   expected idle energy  = baseline watts * workload duration
 *   incremental energy    = raw measured energy - expected idle energy
 *
 * All three values are retained. Negative incremental values are NOT clamped
 * to zero — they indicate the workload drew less than the idle estimate, which
 * is a signal that the measurement is noisy or the baseline is stale.
 */
export function applyBaseline(
  raw: EnergyResult,
  baseline?: Baseline,
): EnergyWithBaseline {
  if (!baseline || raw.totalJoules === undefined) {
    return { raw };
  }
  const estimatedIdleJoules = baseline.watts * (raw.durationMs / 1000);
  const incrementalJoules = raw.totalJoules - estimatedIdleJoules;
  return {
    raw,
    baselineWatts: baseline.watts,
    estimatedIdleJoules,
    incrementalJoules,
    ...(incrementalJoules < 0 ? { negativeIncremental: true } : {}),
  };
}

/** Joules -> milliwatt-hours, for reporting. 1 mWh = 3.6 J. */
export function joulesToMilliwattHours(joules: number): number {
  return joules / 3.6;
}
