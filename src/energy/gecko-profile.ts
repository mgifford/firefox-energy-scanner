/**
 * Gecko profile power-counter extraction.
 *
 * Unit basis (verified against firefox-devtools/profiler,
 * src/components/timeline/TrackCounterTooltipFormat.ts):
 *
 *   const PWH_TO_WH = 1e-12;
 *   const MS_PER_HOUR = 1000 * 3600;
 *   pwhToWh(pwh)  = pwh * PWH_TO_WH
 *
 * Raw counter `count` samples are picowatt-hours. Therefore:
 *
 *   joules = pWh * 1e-12 * 3600
 *
 * This is a documented physical conversion, which is why this module is
 * permitted to report joules. See docs/decision-record.md TDR-001.
 */

export const PWH_TO_WH = 1e-12;
export const WH_TO_J = 3600;

/** Convert picowatt-hours to joules. */
export function pwhToJoules(pwh: number): number {
  return pwh * PWH_TO_WH * WH_TO_J;
}

interface CounterSamples {
  schema: Record<string, number>;
  data: number[][];
}

interface GeckoCounter {
  name?: string;
  category?: string;
  description?: string;
  samples: CounterSamples;
}

interface GeckoProcess {
  meta: { startTime: number; processType?: number };
  counters?: GeckoCounter[];
  processes?: GeckoProcess[];
}

export interface PowerUnit {
  /** Absolute epoch ms corresponding to this process's sample time 0. */
  processStartTime: number;
  samples: CounterSamples;
}

/**
 * Collect every power counter from the parent process and all subprocesses.
 *
 * Each process records sample times relative to its OWN meta.startTime, so the
 * origin is captured alongside the samples. Failing to do this — or omitting
 * content processes, where page JS actually runs — produces physically
 * impossible results. See docs/decision-record.md TDR-003.
 */
export function collectPowerUnits(profile: unknown): PowerUnit[] {
  const units: PowerUnit[] = [];

  const visit = (node: GeckoProcess | undefined): void => {
    if (!node || typeof node !== 'object' || !node.meta) return;
    const processStartTime = node.meta.startTime;
    for (const counter of node.counters ?? []) {
      if (counter?.category === 'power' && counter.samples?.data) {
        units.push({ processStartTime, samples: counter.samples });
      }
    }
    for (const child of node.processes ?? []) visit(child);
  };

  visit(profile as GeckoProcess);
  return units;
}

export interface WindowEnergy {
  joules: number;
  sampleCount: number;
}

/**
 * Integrate power counters over an absolute wall-clock window.
 *
 * Samples are cumulative energy deltas since the previous sample, so summing
 * the `count` column over a window yields the energy used in that window.
 * The window is half-open (start, end] to avoid double counting a boundary
 * sample when two steps are adjacent.
 */
export function energyInWindow(
  units: PowerUnit[],
  startEpochMs: number,
  endEpochMs: number,
): WindowEnergy {
  let pwh = 0;
  let sampleCount = 0;

  for (const unit of units) {
    const timeIndex = unit.samples.schema.time;
    const countIndex = unit.samples.schema.count;
    if (timeIndex === undefined || countIndex === undefined) continue;

    // Translate the absolute window into this process's own time origin.
    const relStart = startEpochMs - unit.processStartTime;
    const relEnd = endEpochMs - unit.processStartTime;

    for (const row of unit.samples.data) {
      const t = row[timeIndex];
      const value = row[countIndex];
      if (t === undefined || value === undefined) continue;
      if (t > relStart && t <= relEnd) {
        pwh += value;
        sampleCount++;
      }
    }
  }

  return { joules: pwhToJoules(pwh), sampleCount };
}
