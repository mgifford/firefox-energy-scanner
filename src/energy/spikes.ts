/**
 * Intervals of elevated power in an energy timeline: where to look, not what
 * is wrong.
 *
 * Method (robust-threshold-v1). A reference level and its spread come from
 * one of:
 *
 * - baseline: the idle baseline window (about:blank) the run measured before
 *   the page, when it has enough bins;
 * - quiet: the quietest share (default half) of the page's own bins, when
 *   there is no baseline: it assumes the page is quiet at least that much;
 * - rolling: a centred rolling median, for local transients; a long plateau
 *   raises its own reference, so it is not for prolonged workloads.
 *
 * The spread is 1.4826 × the median absolute deviation (MAD), which estimates
 * a standard deviation without being pulled by the spikes themselves. A bin is
 * elevated when its power exceeds reference + k × spread (k = 3.5 by default,
 * the usual cut-off for a modified z-score), and by at least minRiseW if one
 * is set (none by default: there is no universal "high" power). Elevated bins
 * within mergeGapMs of one another form one interval; intervals shorter than
 * minDurationMs are dropped. An interval is a brief peak below sustainedMs,
 * sustained above it.
 *
 * Intervals are ranked by excess energy (the energy above the reference
 * level), so a long moderate workload can outrank a short high peak: it costs
 * more. Intervals in warm-up runs (colder caches) come after the measured
 * run's. The highest single bins are listed separately.
 *
 * The power is the whole measurement scope's. An interval says when the
 * browser (or, with RAPL, the machine) drew more, never which element did.
 */

import { median } from '../core/stats.js';
import type { EnergyTimeline, TimelineBin } from './timeline.js';

export const SPIKE_METHOD = 'robust-threshold-v1';

export interface SpikeSettings {
  reference: 'auto' | 'baseline' | 'quiet' | 'rolling';
  /** Robust standard deviations above the reference for a bin to count as elevated. */
  k: number;
  /** Shortest interval reported, ms. Default: two bins. */
  minDurationMs?: number;
  /** Bins below the threshold that may sit inside one interval, in ms. Default: one bin. */
  mergeGapMs?: number;
  /** An interval this long or longer is sustained; shorter, a brief peak. */
  sustainedMs: number;
  /** quiet: the share of the page's bins taken as its quiet level. */
  quietFraction: number;
  /** rolling: the window of the rolling median, ms. */
  rollingWindowMs: number;
  /** An optional floor on the rise above the reference, W. None by default. */
  minRiseW: number;
  /** Fewest reference bins for the baseline reference to be used. */
  minReferenceBins: number;
}

export const DEFAULT_SPIKE_SETTINGS: SpikeSettings = {
  reference: 'auto',
  k: 3.5,
  sustainedMs: 1_000,
  quietFraction: 0.5,
  rollingWindowMs: 5_000,
  minRiseW: 0,
  minReferenceBins: 5,
};

export interface SpikeInterval {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  bins: number;
  peakPowerW: number;
  /** Start of the highest bin in the interval, ms from the origin. */
  peakAtMs: number;
  meanPowerW: number;
  /** Energy read in the interval, J (whole measurement scope). */
  energyJ: number;
  /** Energy above the reference level, J. */
  excessEnergyJ: number;
  referenceW: number;
  thresholdW: number;
  shape: 'brief-peak' | 'sustained';
  /** Phase kinds and steps the interval overlaps. */
  phases: string[];
  steps: string[];
  flags: ('outside-measured-steps' | 'crosses-phase-boundary' | 'includes-lumped-bins' | 'warmup' | 'machine-wide-scope' | 'during-baseline')[];
}

export interface SpikeReport {
  method: typeof SPIKE_METHOD;
  statement: string;
  settings: SpikeSettings & { binMs: number; minDurationMs: number; mergeGapMs: number };
  reference: {
    kind: 'baseline-window' | 'quiet-bins' | 'rolling-median';
    /** Reference power, W (for rolling: the median of the local references). */
    powerW: number;
    /** 1.4826 × MAD of the reference bins, W, or the floor used when that was zero. */
    spreadW: number;
    spreadFrom: 'mad' | 'quantum' | 'none';
    bins: number;
  };
  intervals: SpikeInterval[];
  /** The highest single bins, for context: a bin is not an interval. */
  topBins: { index: number; startMs: number; powerW: number; phase?: string }[];
  warnings: string[];
}

const MAD_SCALE = 1.4826;

function mad(xs: number[], centre: number): number {
  return xs.length ? median(xs.map((x) => Math.abs(x - centre))) : 0;
}

/** The smallest step between distinct values: how finely the bins resolve power. */
function quantum(xs: number[]): number {
  const s = [...new Set(xs.map((x) => Math.round(x * 1e9) / 1e9))].sort((a, b) => a - b);
  let q = Infinity;
  for (let i = 1; i < s.length; i++) q = Math.min(q, s[i]! - s[i - 1]!);
  return Number.isFinite(q) ? q : 0;
}

const phaseName = (t: EnergyTimeline, b: TimelineBin) => (b.phase !== undefined ? t.phases[b.phase] : undefined);

export function detectSpikes(t: EnergyTimeline, overrides: Partial<SpikeSettings> = {}): SpikeReport {
  const settings: SpikeSettings = { ...DEFAULT_SPIKE_SETTINGS, ...overrides };
  const binMs = t.binMs;
  const minDurationMs = settings.minDurationMs ?? 2 * binMs;
  const mergeGapMs = settings.mergeGapMs ?? binMs;
  const warnings: string[] = [];
  const powered = t.bins.filter((b) => b.averagePowerW !== null);
  const isBaseline = (b: TimelineBin) => phaseName(t, b)?.kind === 'baseline';
  const baselineBins = powered.filter(isBaseline);
  const pageBins = powered.filter((b) => !isBaseline(b));

  let kind: SpikeReport['reference']['kind'];
  let refBins: TimelineBin[];
  const want = settings.reference;
  if ((want === 'auto' || want === 'baseline') && baselineBins.length >= settings.minReferenceBins) {
    kind = 'baseline-window';
    refBins = baselineBins;
  } else if (want === 'rolling') {
    kind = 'rolling-median';
    refBins = pageBins;
  } else {
    if (want === 'baseline') warnings.push(`The idle baseline has ${baselineBins.length} usable bins, fewer than ${settings.minReferenceBins}; the page's quietest bins are the reference instead.`);
    kind = 'quiet-bins';
    const sorted = [...pageBins].sort((a, b) => a.averagePowerW! - b.averagePowerW!);
    refBins = sorted.slice(0, Math.max(1, Math.floor(sorted.length * settings.quietFraction)));
  }

  const refPowers = refBins.map((b) => b.averagePowerW!);
  let local: (b: TimelineBin) => number;
  let spread: number;
  if (kind === 'rolling-median') {
    const half = settings.rollingWindowMs / 2;
    const cache = new Map<number, number>();
    local = (b) => {
      if (!cache.has(b.index)) {
        const around = pageBins.filter((x) => Math.abs(x.startMs - b.startMs) <= half).map((x) => x.averagePowerW!);
        cache.set(b.index, around.length ? median(around) : 0);
      }
      return cache.get(b.index)!;
    };
    spread = MAD_SCALE * median(pageBins.map((b) => Math.abs(b.averagePowerW! - local(b))));
  } else {
    const centre = refPowers.length ? median(refPowers) : 0;
    local = () => centre;
    spread = MAD_SCALE * mad(refPowers, centre);
  }
  let spreadFrom: SpikeReport['reference']['spreadFrom'] = 'mad';
  if (!(spread > 0)) {
    // A spread of zero would make any rise an interval. Use the smallest
    // power step the bins resolve instead, and say so.
    const q = quantum(kind === 'rolling-median' ? pageBins.map((b) => b.averagePowerW!) : refPowers);
    spread = q;
    spreadFrom = q > 0 ? 'quantum' : 'none';
    warnings.push(
      q > 0
        ? `The reference bins barely vary (MAD of zero); the smallest power step the bins resolve (${q.toPrecision(3)} W) is used as their spread.`
        : 'The reference bins do not vary at all, so no spread could be estimated; every bin above the reference counts as elevated.',
    );
  }
  if (refBins.length < settings.minReferenceBins) warnings.push(`Only ${refBins.length} reference bins: the reference level is uncertain.`);
  if (kind === 'quiet-bins') warnings.push(`No usable idle baseline: the reference is the quietest ${Math.round(settings.quietFraction * 100)}% of the page's own bins, so a page that is busy throughout shows fewer intervals than it should.`);
  if (kind === 'rolling-median') warnings.push('A rolling reference rises with a long workload, so prolonged elevated power can go unreported: it finds local transients.');

  const threshold = (b: TimelineBin) => local(b) + Math.max(settings.k * spread, settings.minRiseW);
  // The reference window itself is not searched.
  const candidates = t.bins.filter((b) => !(kind === 'baseline-window' && isBaseline(b)));
  const above = (b: TimelineBin) => b.averagePowerW !== null && b.averagePowerW > threshold(b);

  // An interval stays within one part of the workload: load (loading and
  // settling), idle, one interaction, or the time between steps. Evidence
  // differs between them, so an elevation that runs from load into idle is
  // two intervals.
  const part = (b: TimelineBin) => {
    const p = phaseName(t, b);
    if (!p) return 'unmeasured';
    const kind = p.kind === 'loading' || p.kind === 'stabilizing' ? 'load' : p.kind;
    return `${kind}|${p.label}`;
  };
  const groups: TimelineBin[][] = [];
  let current: TimelineBin[] = [];
  let gap = 0;
  for (const b of candidates) {
    if (current.length && part(b) !== part(current[0]!)) {
      groups.push(current);
      current = [];
      gap = 0;
    }
    if (above(b)) {
      current.push(b);
      gap = 0;
    } else if (current.length) {
      gap += b.endMs - b.startMs;
      if (gap > mergeGapMs) {
        groups.push(current);
        current = [];
        gap = 0;
      } else current.push(b);
    }
  }
  if (current.length) groups.push(current);

  const intervals: Omit<SpikeInterval, 'id' | 'rank'>[] = [];
  for (const g of groups) {
    // Trim trailing bins that were only a gap.
    while (g.length && !above(g.at(-1)!)) g.pop();
    if (!g.length) continue;
    const startMs = g[0]!.startMs;
    const endMs = g.at(-1)!.endMs;
    const durationMs = endMs - startMs;
    if (durationMs < minDurationMs) continue;
    const withPower = g.filter((b) => b.averagePowerW !== null);
    const energyJ = g.reduce((a, b) => a + (b.energyJ ?? 0), 0);
    const excessEnergyJ = withPower.reduce((a, b) => a + Math.max(0, b.averagePowerW! - local(b)) * ((b.endMs - b.startMs) / 1000), 0);
    const phases = g.map((b) => phaseName(t, b));
    const flags: SpikeInterval['flags'] = [];
    if (phases.some((p) => !p)) flags.push('outside-measured-steps');
    if (new Set(phases.map((p) => p?.label ?? '') ).size > 1 || new Set(phases.map((p) => p?.kind ?? '')).size > 1) flags.push('crosses-phase-boundary');
    if (g.some((b) => b.flags?.includes('lumped'))) flags.push('includes-lumped-bins');
    if (phases.every((p) => p?.warmup)) flags.push('warmup');
    if (phases.some((p) => p?.kind === 'baseline')) flags.push('during-baseline');
    if (t.scope !== 'process') flags.push('machine-wide-scope');
    intervals.push({
      startMs,
      endMs,
      durationMs,
      bins: g.length,
      peakPowerW: Math.max(...withPower.map((b) => b.averagePowerW!)),
      peakAtMs: withPower.reduce((a, b) => (b.averagePowerW! > a.averagePowerW! ? b : a)).startMs,
      meanPowerW: energyJ / Math.max(0.001, durationMs / 1000),
      energyJ,
      excessEnergyJ,
      referenceW: median(g.map(local)),
      thresholdW: median(g.map(threshold)),
      shape: durationMs >= settings.sustainedMs ? 'sustained' : 'brief-peak',
      phases: [...new Set(phases.map((p) => (p ? p.kind : 'unmeasured')))],
      steps: [...new Set(phases.filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.label))],
      flags,
    });
  }
  // The measured run first, then warm-ups (colder caches); within each, by energy above the reference.
  const warm = (x: { flags: SpikeInterval['flags'] }) => (x.flags.includes('warmup') ? 1 : 0);
  intervals.sort((a, b) => warm(a) - warm(b) || b.excessEnergyJ - a.excessEnergyJ || a.startMs - b.startMs);

  const topBins = [...pageBins]
    .sort((a, b) => b.averagePowerW! - a.averagePowerW!)
    .slice(0, 5)
    .map((b) => ({ index: b.index, startMs: b.startMs, powerW: b.averagePowerW!, ...(phaseName(t, b) ? { phase: phaseName(t, b)!.kind } : {}) }));

  if (!powered.length) warnings.push('No bin has a power value: nothing could be detected.');

  return {
    method: SPIKE_METHOD,
    statement:
      `Intervals where measured power stayed above the reference level by more than ${settings.k} robust standard deviations (1.4826 × MAD)` +
      `${settings.minRiseW > 0 ? ` and at least ${settings.minRiseW} W` : ''}, for at least ${minDurationMs} ms. ` +
      'They are times worth investigating, not defects. Their power is the whole measurement scope’s, never one component’s or script’s.',
    settings: { ...settings, binMs, minDurationMs, mergeGapMs },
    reference: { kind, powerW: refPowers.length ? median(kind === 'rolling-median' ? pageBins.map(local) : refPowers) : 0, spreadW: spread, spreadFrom, bins: refBins.length },
    intervals: intervals.map((x, i) => ({ id: `spike-${i + 1}`, rank: i + 1, ...x })),
    topBins,
    warnings: [...warnings, ...t.warnings.filter((w) => /whole CPU package|whole platform/.test(w))],
  };
}
