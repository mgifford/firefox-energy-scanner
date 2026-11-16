/**
 * The idle baseline and the basis of an experiment's comparison, after the
 * first experiments on an Apple M2: the idle window shortly after Firefox
 * started held its own start-up work, its mean was about 100 times its
 * median, and every light page measured "below idle".
 */
import { describe, it, expect } from 'vitest';
import { deriveBaseline, applyBaseline } from '../src/core/baseline.js';
import { collectPowerUnits, selectPowerUnits } from '../src/energy/gecko-profile.js';
import { medianWindowPower, buildTimeline } from '../src/energy/timeline.js';
import { summarizeExperiment, refreshDifferences, type ExperimentReport } from '../src/experiments/experiment.js';
import type { EnergyResult, StepResult } from '../src/core/types.js';

const T0 = 1_700_000_000_000;
const pwh = (j: number) => j / 3.6e-9;
const counter = (watts: (t: number) => number, to = 10_000) => {
  const rows: number[][] = [];
  for (let t = 10; t <= to; t += 10) rows.push([t, pwh(watts(t) * 0.01)]);
  return { meta: { startTime: T0 }, counters: [{ name: 'Process Power', category: 'power', samples: { schema: { time: 0, count: 1 }, data: rows } }] };
};

describe('the idle baseline', () => {
  // About 1 mW, with Firefox's own start-up bursts at 1 W for a second and a half.
  const idle = (t: number) => (t > 2_000 && t <= 3_500 ? 1 : 0.001);

  it('is the median of the window, so the browser’s own bursts do not inflate it', () => {
    const sel = selectPowerUnits(collectPowerUnits(counter(idle)));
    const m = medianWindowPower(sel, T0, T0 + 10_000)!;
    expect(m.watts).toBeCloseTo(0.001, 6);
    expect(m.bins).toBe(40);
    const raw: EnergyResult = { durationMs: 10_000, totalJoules: 1.5085, measurementScope: 'process', measurementType: 'hardware-estimate', attribution: 'time-window', adapterId: 'firefox-profiler', sampleCount: 1000 };
    const b = deriveBaseline(raw, m)!;
    expect(b).toMatchObject({ method: 'median-of-bins' });
    expect(b.watts).toBeCloseTo(0.001, 6);
    expect(b.meanWatts!).toBeCloseTo(0.15085, 5);
    expect(deriveBaseline(raw)).toMatchObject({ method: 'mean' });
    // A light idle page at 17 mW is now above idle, as it is.
    const page: EnergyResult = { ...raw, totalJoules: 0.17 };
    expect(applyBaseline(page, b).incrementalJoules!).toBeGreaterThan(0);
    expect(applyBaseline(page, deriveBaseline(raw)).incrementalJoules!).toBeLessThan(0);
    expect(applyBaseline(page, b).baselineMethod).toBe('median-of-bins');
  });

  it('is not given from too few bins', () => {
    const sel = selectPowerUnits(collectPowerUnits(counter(() => 0.001, 800)));
    expect(medianWindowPower(sel, T0, T0 + 800)).toBeUndefined();
  });
});

describe('the basis of a comparison', () => {
  const run = (scenario: string, step: string, i: number, rawMwh: number, baselineMw: number, ms = 10_000): StepResult => ({
    scenario, step, run: i, warmup: false, startedAt: 0, endedAt: 1, timing: { durationMs: ms }, valid: true, warnings: [],
    energy: {
      raw: { durationMs: ms, totalJoules: rawMwh * 3.6, measurementScope: 'process', measurementType: 'hardware-estimate', attribution: 'time-window', adapterId: 'x', sampleCount: 1000 },
      baselineWatts: baselineMw / 1000,
      baselineMethod: 'mean',
      incrementalJoules: rawMwh * 3.6 - (baselineMw / 1000) * (ms / 1000),
    },
  });
  const wobble = (i: number) => ((i % 5) - 2) * 0.0005;
  // As on the M2: idle windows of about 0.047 and 0.022 mWh, a baseline mean near 100 mW.
  const a = Array.from({ length: 10 }, (_, i) => run('baseline', 'idle', i, 0.047 + wobble(i), 100 + (i % 3) * 5));
  const b = Array.from({ length: 10 }, (_, i) => run('variant', 'idle', i, 0.022 + wobble(i), 100 + (i % 4) * 5));

  it('uses window energy when the baseline exceeded what the step drew, and says why', () => {
    const [d] = summarizeExperiment(a, b);
    expect(d!.energy!.basis).toBe('window');
    expect(d!.verdict).toBe('lower');
    expect(d!.energy!.differenceMwh).toBeCloseTo(-0.025, 4);
    expect(d!.energy!.baselineMw![0]).toBeGreaterThan(99);
    expect(d!.reading).toMatch(/^On window energy, with no baseline subtracted: The variant used 0\.025 mWh less/);
    expect(d!.reading).toMatch(/was more than this step drew/);
  });

  it('keeps incremental energy when it can be read, with window energy beside it', () => {
    const a2 = a.map((r) => ({ ...r, energy: { ...r.energy!, baselineWatts: 0.001, baselineMethod: 'median-of-bins' as const, incrementalJoules: r.energy!.raw.totalJoules! - 0.01 } }));
    const b2 = b.map((r) => ({ ...r, energy: { ...r.energy!, baselineWatts: 0.001, baselineMethod: 'median-of-bins' as const, incrementalJoules: r.energy!.raw.totalJoules! - 0.01 } }));
    const [d] = summarizeExperiment(a2, b2);
    expect(d!.energy).toMatchObject({ basis: 'incremental', baselineMethod: 'median-of-bins' });
    expect(d!.verdict).toBe('lower');
    expect(d!.energy!.window!.verdict).toBe('lower');
  });

  it('recomputes a stored experiment’s differences from its own runs', () => {
    const stored = { scenarios: [...a, ...b], experiment: { applied: { ok: true, note: '' }, variant: { kind: 'remove' }, differences: [{ step: 'idle', verdict: 'below-resolution' }] } as unknown as ExperimentReport };
    refreshDifferences(stored);
    expect(stored.experiment.differences[0]).toMatchObject({ step: 'idle', verdict: 'lower', role: 'attributable' });
    const failed = { scenarios: [...a, ...b], experiment: { applied: { ok: false, note: '' }, variant: { kind: 'remove' }, differences: [] } as unknown as ExperimentReport };
    refreshDifferences(failed);
    expect(failed.experiment.differences).toEqual([]);
  });
});

describe('a load shorter than a bin', () => {
  it('owns the bin it falls in, rather than reading as time between steps', () => {
    const sel = selectPowerUnits(collectPowerUnits(counter(() => 0.01, 4_000)));
    const t = buildTimeline(sel, [
      { label: 'run:0:load', startedAt: T0 + 1_120, endedAt: T0 + 1_220, actionEndedAt: T0 + 1_200 },
      { label: 'run:0:idle', startedAt: T0 + 2_000, endedAt: T0 + 4_000 },
    ], { binMs: 250, fromEpochMs: T0, toEpochMs: T0 + 4_000 })!;
    const bin = t.bins.find((x) => x.startMs === 1_000)!;
    expect(t.phases[bin.phase!]!.kind).toBe('loading');
    expect(t.bins.find((x) => x.startMs === 1_500)!.phase).toBeUndefined();
  });
});
