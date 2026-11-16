import type { EnergyResult, EnergyWithBaseline } from './types.js';

export interface Baseline {
  watts: number;
  durationMs: number;
  samples: number;
  adapterId: string;
  /**
   * How `watts` was found. median-of-bins: the median power of the idle
   * window's time bins, so the browser's own bursts of work in it (start-up
   * tasks, update checks) do not inflate the floor. mean: the window's energy
   * over its length. Absent in results made before the median was used: mean.
   */
  method?: 'median-of-bins' | 'mean';
  /** The window's mean power, W, kept beside the median so a burst in it stays visible. */
  meanWatts?: number;
}

/**
 * Derive idle baseline power from an idle measurement.
 *
 *   baseline watts = median power of the idle window's bins, when known
 *                  = idle joules / idle seconds, otherwise
 *
 * Why the median: on an Apple M2 with Firefox 153, the idle window shortly
 * after start-up held Firefox's own start-up work. Its mean was about 100 mW
 * while its bins' median was about 1 mW, so every light page measured "below
 * idle" and no experiment could resolve. The idle floor is what the browser
 * draws when it is doing nothing; bursts in it are not idle.
 */
export function deriveBaseline(idle: EnergyResult, robust?: { watts: number; bins: number }): Baseline | undefined {
  if (idle.totalJoules === undefined || idle.durationMs <= 0) return undefined;
  const meanWatts = idle.totalJoules / (idle.durationMs / 1000);
  return {
    watts: robust ? robust.watts : meanWatts,
    durationMs: idle.durationMs,
    samples: idle.sampleCount ?? 0,
    adapterId: idle.adapterId,
    method: robust ? 'median-of-bins' : 'mean',
    meanWatts,
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
    ...(baseline.method ? { baselineMethod: baseline.method } : {}),
    estimatedIdleJoules,
    incrementalJoules,
    ...(incrementalJoules < 0 ? { negativeIncremental: true } : {}),
  };
}

/** Joules -> milliwatt-hours, for reporting. 1 mWh = 3.6 J. */
export function joulesToMilliwattHours(joules: number): number {
  return joules / 3.6;
}
