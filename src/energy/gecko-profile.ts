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
  /** Counter label, e.g. "Process Power" or "Power: CPU package". */
  name: string;
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
        units.push({ name: counter.name ?? '', processStartTime, samples: counter.samples });
      }
    }
    for (const child of node.processes ?? []) visit(child);
  };

  visit(profile as GeckoProcess);
  return units;
}

/**
 * Which counters to add up, and what the total covers.
 *
 * Firefox exposes two kinds of power counter, and they must not be mixed:
 *
 *   per-process   "Process Power", one per Firefox process (Apple Silicon).
 *                 They are disjoint, so summing them gives Firefox's energy.
 *
 *   system-wide   "Power: CPU package", "Power: CPU cores", "Power: iGPU",
 *                 "Power: DRAM", "Power: System", "Power: CPU core N"
 *                 (Linux RAPL, Windows EMI, Intel Macs). These are RAPL
 *                 domains and they NEST: the package already contains the
 *                 cores and the integrated GPU, and "System" (psys) contains
 *                 the package. Summing them double-counts.
 *
 * Labels are taken from Firefox's tools/profiler/core/PowerCounters-*.cpp.
 */
export interface PowerSelection {
  units: PowerUnit[];
  scope: 'process' | 'cpu-package' | 'system';
  /** Plain description of what was summed, for reports. */
  basis: string;
}

export function selectPowerUnits(all: PowerUnit[]): PowerSelection {
  const named = (re: RegExp) => all.filter((u) => re.test(u.name));
  const perProcess = named(/^Process Power$/i);
  if (perProcess.length > 0) {
    return {
      units: perProcess,
      scope: 'process',
      basis: 'Firefox per-process power counters, summed across the parent and content processes.',
    };
  }

  const psys = named(/^Power: System$/i);
  if (psys.length > 0) {
    return {
      units: psys,
      scope: 'system',
      basis:
        'RAPL "psys" (Power: System): the whole platform as the CPU reports it, for every process on the machine.',
    };
  }

  const pkg = named(/^Power: CPU package$/i);
  if (pkg.length > 0) {
    const dram = named(/^Power: DRAM$/i);
    return {
      units: [...pkg, ...dram],
      scope: 'cpu-package',
      basis:
        'RAPL CPU package' + (dram.length ? ' plus DRAM' : '') +
        ': the whole processor (cores and integrated GPU included), for every process on the machine. ' +
        'Cores and iGPU counters are inside the package and are not added again.',
    };
  }

  // An unrecognised set, e.g. vendor-named channels on Windows on ARM. With
  // no way to tell whether they nest, take the single largest rather than
  // risk adding overlapping domains.
  const withData = all.filter((u) => u.samples.data.length > 0);
  if (withData.length === 0) return { units: all, scope: 'system', basis: 'No power samples.' };
  const total = (u: PowerUnit) => {
    const i = u.samples.schema.count;
    return i === undefined ? 0 : u.samples.data.reduce((acc, row) => acc + (row[i] ?? 0), 0);
  };
  const largest = withData.reduce((a, b) => (total(b) > total(a) ? b : a));
  return {
    units: [largest],
    scope: 'system',
    basis: `Unrecognised power counters; used the largest single one ("${largest.name}") so overlapping domains are not added together.`,
  };
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
