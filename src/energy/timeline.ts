/**
 * The energy timeline: Firefox's power-counter samples in time bins, with
 * the measured steps they fell in.
 *
 * The same counters, the same selection (no nested RAPL domains added
 * together) and the same per-process clocks as the step totals
 * (gecko-profile.ts), so a step's bins add up to what energyInWindow reports
 * for it. Nothing is interpolated:
 *
 * - a bin with no sample has no energy (null), not zero;
 * - a bin narrower than the counters' own update interval is refused, and the
 *   narrowest bin the samples support is used instead;
 * - a sample whose energy covers more than its bin (after a gap in the
 *   counter, or a coarse counter) keeps its energy in the bin it was read in,
 *   but the bin's average power is not derived (null), so it cannot read as
 *   a spike.
 *
 * Power here is the measurement scope's: Firefox's processes on Apple
 * Silicon, the whole CPU package or platform elsewhere. It is never a
 * component's or a script's.
 */

import { pwhToJoules, type PowerSelection } from './gecko-profile.js';
import { median } from '../core/stats.js';

export const TIMELINE_SCHEMA = 'energy-timeline/1';

/** Bin widths offered to a reader, where the samples support them. */
export const STANDARD_BINS_MS = [100, 250, 500, 1000];

export type PhaseKind = 'baseline' | 'loading' | 'stabilizing' | 'idle' | 'interaction' | 'unmeasured';

export interface TimelinePhase {
  kind: PhaseKind;
  /** The step's name as the run recorded it (load, idle, a URL, a journey step). */
  step: string;
  /** The runner's label: run:0:load, warmup:0:idle, __baseline__. */
  label: string;
  run?: number;
  warmup: boolean;
  /** ms from the timeline's origin. */
  startMs: number;
  endMs: number;
}

export type BinFlag = 'no-samples' | 'lumped' | 'unit-missing' | 'phase-boundary' | 'first-sample';

export interface TimelineBin {
  index: number;
  /** ms from the origin; the bin is (startMs, endMs], as step windows are. */
  startMs: number;
  endMs: number;
  samples: number;
  /** Energy read in this bin, J. Null when no sample was read: not zero. */
  energyJ: number | null;
  /** Energy over the bin's width, W. Null when there is no energy, or it covers more than this bin. */
  averagePowerW: number | null;
  /** The phase at the bin's middle, as an index into phases; absent between measured steps. */
  phase?: number;
  flags?: BinFlag[];
}

export interface EnergyTimeline {
  schema: typeof TIMELINE_SCHEMA;
  /** Epoch ms of time zero: the start of the first recorded window. */
  originEpochMs: number;
  durationMs: number;
  binMs: number;
  requestedBinMs: number;
  resolution: {
    /** Median interval between samples, across counters. */
    sampleIntervalMs: number | null;
    /** Median interval between samples that carried energy: how often the counters actually move. */
    counterUpdateMs: number | null;
    /** The narrowest bin the samples support (twice the counter update interval, rounded up). */
    minimumBinMs: number;
    /** Which of 100, 250, 500 and 1000 ms the samples support. */
    supportedBinsMs: number[];
  };
  scope: PowerSelection['scope'];
  basis: string;
  /** Counters summed (one per Firefox process, or the selected RAPL domains). */
  counters: number;
  samples: { used: number; excluded: Record<string, number> };
  /** Intervals where a counter that was reporting went quiet for longer than three of its updates. */
  gaps: { startMs: number; endMs: number; counter: number }[];
  phases: TimelinePhase[];
  bins: TimelineBin[];
  /** Profiler features the run used. Beyond "power", stack sampling adds work to what is measured. */
  profilerFeatures: string[];
  samplingIntervalMs?: number;
  /** The run this timeline belongs to, when a result holds several. */
  scenario?: string;
  run?: number;
  warnings: string[];
  method: string;
}

/** A measured window, as the runner recorded it. */
export interface WindowRecord {
  label: string;
  startedAt: number;
  endedAt: number;
  /** When the step's action ended and waiting for the page to settle began. */
  actionEndedAt?: number;
}

interface Sample {
  t: number;
  j: number;
  counter: number;
  /** ms of counter activity this sample's energy covers (since the counter last moved). */
  coversMs: number;
  first: boolean;
}

const LABEL = /^(warmup|run):(\d+):(.*)$/s;

/** Phases from the runner's windows: baseline, load split into loading and stabilizing, idle, interactions. */
export function phasesFrom(windows: WindowRecord[], originEpochMs: number): TimelinePhase[] {
  const out: TimelinePhase[] = [];
  for (const w of [...windows].sort((a, b) => a.startedAt - b.startedAt)) {
    const rel = (t: number) => t - originEpochMs;
    if (w.label === '__baseline__') {
      out.push({ kind: 'baseline', step: 'idle baseline', label: w.label, warmup: false, startMs: rel(w.startedAt), endMs: rel(w.endedAt) });
      continue;
    }
    const m = LABEL.exec(w.label);
    const step = m ? m[3]! : w.label;
    const base = { step, label: w.label, warmup: m?.[1] === 'warmup', ...(m ? { run: Number(m[2]) } : {}) };
    const loads = step === 'load' || /^https?:\/\//.test(step);
    if (step === 'idle' || /idle/i.test(step)) {
      out.push({ ...base, kind: 'idle', startMs: rel(w.startedAt), endMs: rel(w.endedAt) });
    } else if (w.actionEndedAt !== undefined && w.actionEndedAt > w.startedAt && w.actionEndedAt < w.endedAt) {
      out.push({ ...base, kind: loads ? 'loading' : 'interaction', startMs: rel(w.startedAt), endMs: rel(w.actionEndedAt) });
      out.push({ ...base, kind: 'stabilizing', startMs: rel(w.actionEndedAt), endMs: rel(w.endedAt) });
    } else {
      out.push({ ...base, kind: loads ? 'loading' : 'interaction', startMs: rel(w.startedAt), endMs: rel(w.endedAt) });
    }
  }
  return out;
}

/** The counters' samples, validated, on the shared epoch clock. */
function samplesOf(selection: PowerSelection, excluded: Record<string, number>): Sample[][] {
  const out: Sample[][] = [];
  selection.units.forEach((unit, counter) => {
    const ti = unit.samples.schema.time;
    const ci = unit.samples.schema.count;
    if (ti === undefined || ci === undefined) {
      excluded['no-time-or-count-column'] = (excluded['no-time-or-count-column'] ?? 0) + unit.samples.data.length;
      return;
    }
    const rows: Sample[] = [];
    for (const row of unit.samples.data) {
      const t = row[ti];
      const v = row[ci];
      if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !Number.isFinite(v)) {
        excluded['not-a-number'] = (excluded['not-a-number'] ?? 0) + 1;
        continue;
      }
      if (v < 0) {
        excluded['negative-energy'] = (excluded['negative-energy'] ?? 0) + 1;
        continue;
      }
      rows.push({ t: unit.processStartTime + t, j: pwhToJoules(v), counter, coversMs: 0, first: false });
    }
    rows.sort((a, b) => a.t - b.t);
    out.push(rows);
  });
  return out;
}

const LADDER = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

export interface TimelineOptions {
  binMs?: number;
  /** Defaults: the first window's start and the last window's end. */
  fromEpochMs?: number;
  toEpochMs?: number;
  profilerFeatures?: string[];
  samplingIntervalMs?: number;
  scenario?: string;
  run?: number;
}

/**
 * Bin the selected counters' samples between the first and last recorded
 * windows. Pure: built from the selection the step totals use.
 */
export function buildTimeline(selection: PowerSelection, windows: WindowRecord[], options: TimelineOptions = {}): EnergyTimeline | undefined {
  const excluded: Record<string, number> = {};
  const perCounter = samplesOf(selection, excluded);
  const all = perCounter.flat();
  if (!all.length) return undefined;

  // How often the counters move: per counter, the median interval between
  // samples and between samples that carried energy.
  const intervals: number[] = [];
  const updates: number[] = [];
  const counterUpdate: number[] = [];
  for (const rows of perCounter) {
    const own: number[] = [];
    let lastMoved: number | undefined;
    rows.forEach((s, i) => {
      if (i > 0) intervals.push(s.t - rows[i - 1]!.t);
      if (s.j > 0) {
        if (lastMoved !== undefined) own.push(s.t - lastMoved);
        lastMoved = s.t;
      }
    });
    updates.push(...own);
    counterUpdate.push(own.length >= 3 ? median(own) : NaN);
  }
  const sampleIntervalMs = intervals.length ? median(intervals) : null;
  const counterUpdateMs = updates.length ? median(updates) : null;
  const resolutionMs = Math.max(sampleIntervalMs ?? 0, counterUpdateMs ?? 0);
  const minimumBinMs = LADDER.find((b) => b >= 2 * resolutionMs) ?? Math.ceil(2 * resolutionMs);
  const supportedBinsMs = STANDARD_BINS_MS.filter((b) => b >= minimumBinMs);
  const requestedBinMs = options.binMs ?? 250;
  const warnings: string[] = [];
  let binMs = requestedBinMs;
  if (binMs < minimumBinMs) {
    binMs = supportedBinsMs[0] ?? minimumBinMs;
    warnings.push(`A ${requestedBinMs} ms bin is finer than these counters resolve (they move about every ${Math.round(resolutionMs)} ms), so ${binMs} ms bins are used.`);
  }

  // Each sample's coverage: since its counter last moved. A counter's first
  // sample has no previous one, so it is taken to cover one update interval.
  perCounter.forEach((rows, k) => {
    const own = Number.isFinite(counterUpdate[k]!) ? counterUpdate[k]! : resolutionMs;
    let lastMoved: number | undefined;
    rows.forEach((s, i) => {
      if (i === 0) s.first = true;
      s.coversMs = lastMoved === undefined ? own : s.t - lastMoved;
      if (s.j > 0) lastMoved = s.t;
    });
  });

  const starts = windows.map((w) => w.startedAt);
  const ends = windows.map((w) => w.endedAt);
  // Without windows (a profile on its own), from just before the first sample.
  const from = options.fromEpochMs ?? (starts.length ? Math.min(...starts) : Math.min(...all.map((s) => s.t)) - Math.max(1, sampleIntervalMs ?? 1));
  const to = options.toEpochMs ?? (ends.length ? Math.max(...ends) : Math.max(...all.map((s) => s.t)));
  const durationMs = Math.max(0, to - from);
  const n = Math.max(1, Math.ceil(durationMs / binMs));
  const phases = phasesFrom(windows, from);

  // Gaps: a counter that was reporting goes quiet for more than three of its updates.
  const gaps: EnergyTimeline['gaps'] = [];
  perCounter.forEach((rows, k) => {
    const own = Number.isFinite(counterUpdate[k]!) ? counterUpdate[k]! : resolutionMs;
    const limit = Math.max(3 * own, 3 * (sampleIntervalMs ?? 0), 30);
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.t - rows[i - 1]!.t;
      if (gap > limit && rows[i]!.t > from && rows[i - 1]!.t < to) gaps.push({ startMs: Math.round(rows[i - 1]!.t - from), endMs: Math.round(rows[i]!.t - from), counter: k });
    }
  });

  const bins: TimelineBin[] = Array.from({ length: n }, (_, i) => ({ index: i, startMs: i * binMs, endMs: Math.min((i + 1) * binMs, Math.max(binMs, durationMs)), samples: 0, energyJ: null, averagePowerW: null }));
  const lumped = new Set<number>();
  const firsts = new Set<number>();
  const seen = bins.map(() => new Set<number>());
  let used = 0;
  for (const s of all) {
    const rel = s.t - from;
    // Half-open (start, end], as energyInWindow: a sample on a boundary belongs to the earlier bin.
    if (rel <= 0 || rel > durationMs) {
      excluded['outside-recorded-windows'] = (excluded['outside-recorded-windows'] ?? 0) + 1;
      continue;
    }
    const i = Math.min(n - 1, Math.ceil(rel / binMs) - 1);
    const b = bins[i]!;
    b.samples++;
    b.energyJ = (b.energyJ ?? 0) + s.j;
    seen[i]!.add(s.counter);
    if (s.j > 0 && s.coversMs > binMs) lumped.add(i);
    if (s.first) firsts.add(i);
    used++;
  }

  // Which counters were reporting around each bin: between their first and last sample.
  const alive = perCounter.map((rows) => (rows.length ? [rows[0]!.t - from, rows.at(-1)!.t - from] : [Infinity, -Infinity]));
  const phaseAt = (t: number) => {
    const k = phases.findIndex((p) => t > p.startMs && t <= p.endMs);
    return k < 0 ? undefined : k;
  };
  for (const b of bins) {
    const flags: BinFlag[] = [];
    if (b.samples === 0) flags.push('no-samples');
    if (lumped.has(b.index)) flags.push('lumped');
    if (firsts.has(b.index)) flags.push('first-sample');
    const reporting = alive.filter(([a, z]) => a! < b.endMs && z! > b.startMs).length;
    if (b.samples > 0 && seen[b.index]!.size < reporting && binMs >= 2 * resolutionMs) {
      // A counter alive on both sides of the bin read nothing inside it.
      const missing = alive.some(([a, z], k) => a! < b.startMs && z! > b.endMs && !seen[b.index]!.has(k) && (counterUpdate[k] ?? 0) * 2 <= binMs);
      if (missing) flags.push('unit-missing');
    }
    const p0 = phaseAt(b.startMs + 0.001);
    const p1 = phaseAt(b.endMs);
    // The measured step the bin overlaps most. A step shorter than a bin (a fast
    // load) still owns the bin it falls in; time between steps only gets the bins
    // that touch no step. Bins on a boundary are flagged either way.
    let mid: number | undefined;
    let most = 0;
    phases.forEach((p, k) => {
      const overlap = Math.min(b.endMs, p.endMs) - Math.max(b.startMs, p.startMs);
      if (overlap > most) {
        most = overlap;
        mid = k;
      }
    });
    if (p0 !== p1) flags.push('phase-boundary');
    if (mid !== undefined) b.phase = mid;
    const width = (b.endMs - b.startMs) / 1000;
    if (b.energyJ !== null && !lumped.has(b.index) && width > 0) b.averagePowerW = b.energyJ / width;
    if (flags.length) b.flags = flags;
  }

  const features = options.profilerFeatures ?? ['power'];
  if (selection.scope !== 'process') {
    warnings.push(`These counters cover ${selection.scope === 'cpu-package' ? 'the whole CPU package' : 'the whole platform'}: every process on the machine, not only Firefox. Activity elsewhere on the machine shows here too.`);
  }
  if (features.some((f) => f !== 'power')) {
    warnings.push(`Profiled with ${features.filter((f) => f !== 'power').join(', ')} as well as power: stack sampling adds work to what is measured. Use this timeline to find where to look, not as a benchmark.`);
  }
  if (gaps.length) warnings.push(`${gaps.length} gap${gaps.length === 1 ? '' : 's'} where a counter stopped reporting; the energy after each gap is kept, but its power is not derived.`);
  if ((excluded['negative-energy'] ?? 0) + (excluded['not-a-number'] ?? 0) > 0) warnings.push('Some samples were not usable (negative or not a number) and were left out.');

  return {
    schema: TIMELINE_SCHEMA,
    originEpochMs: from,
    durationMs,
    binMs,
    requestedBinMs,
    resolution: { sampleIntervalMs, counterUpdateMs, minimumBinMs, supportedBinsMs },
    scope: selection.scope,
    basis: selection.basis,
    counters: selection.units.length,
    samples: { used, excluded },
    gaps: gaps.slice(0, 50),
    phases,
    bins,
    profilerFeatures: features,
    ...(options.samplingIntervalMs !== undefined ? { samplingIntervalMs: options.samplingIntervalMs } : {}),
    ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
    ...(options.run !== undefined ? { run: options.run } : {}),
    warnings,
    method:
      'Firefox power-counter samples (the selection the step totals use), on each process’s own clock, summed into fixed bins between the first and last measured windows. ' +
      'A bin’s energy is what the counters read in it; its power is that energy over the bin’s width. Bins without samples have no energy, and bins whose energy reaches back beyond them have no power.',
  };
}

/** Rebin a timeline at a coarser width that is a multiple of its own. */
export function rebin(t: EnergyTimeline, binMs: number): EnergyTimeline {
  if (binMs <= t.binMs || binMs % t.binMs !== 0) return t;
  const k = binMs / t.binMs;
  const bins: TimelineBin[] = [];
  for (let i = 0; i < t.bins.length; i += k) {
    const group = t.bins.slice(i, i + k);
    const withEnergy = group.filter((b) => b.energyJ !== null);
    const energyJ = withEnergy.length ? withEnergy.reduce((a, b) => a + b.energyJ!, 0) : null;
    const startMs = group[0]!.startMs;
    const endMs = group.at(-1)!.endMs;
    const flags = [...new Set(group.flatMap((b) => b.flags ?? []))].filter((f) => f !== 'no-samples' || withEnergy.length === 0);
    const lumped = flags.includes('lumped');
    const phases = group.map((b) => b.phase);
    const bin: TimelineBin = {
      index: bins.length,
      startMs,
      endMs,
      samples: group.reduce((a, b) => a + b.samples, 0),
      energyJ,
      averagePowerW: energyJ !== null && !lumped ? energyJ / ((endMs - startMs) / 1000) : null,
      ...(phases[Math.floor(phases.length / 2)] !== undefined ? { phase: phases[Math.floor(phases.length / 2)] } : {}),
    };
    if (new Set(phases).size > 1 && !flags.includes('phase-boundary')) flags.push('phase-boundary');
    if (flags.length) bin.flags = flags as BinFlag[];
    bins.push(bin);
  }
  return { ...t, binMs, bins };
}

/** Energy of the bins inside a phase, J; null when none had a sample. */
export function phaseEnergy(t: EnergyTimeline, phase: number): number | null {
  const own = t.bins.filter((b) => b.phase === phase && b.energyJ !== null);
  return own.length ? own.reduce((a, b) => a + b.energyJ!, 0) : null;
}

/**
 * The typical power of a window: the median of its bins' power, on the
 * narrowest bins the counters support (at least 250 ms). Undefined with fewer
 * than five bins that have power, when the median would not be typical of
 * anything.
 */
export function medianWindowPower(selection: PowerSelection, startEpochMs: number, endEpochMs: number): { watts: number; bins: number } | undefined {
  const t = buildTimeline(selection, [], { binMs: 250, fromEpochMs: startEpochMs, toEpochMs: endEpochMs });
  const powers = (t?.bins ?? []).filter((b) => b.averagePowerW !== null).map((b) => b.averagePowerW!);
  if (powers.length < 5) return undefined;
  return { watts: median(powers), bins: powers.length };
}
