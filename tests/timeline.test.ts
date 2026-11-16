import { describe, it, expect } from 'vitest';
import { collectPowerUnits, energyInWindow, selectPowerUnits } from '../src/energy/gecko-profile.js';
import { buildTimeline, phasesFrom, rebin, phaseEnergy, type WindowRecord } from '../src/energy/timeline.js';
import { detectSpikes } from '../src/energy/spikes.js';
import { geckoEvidence, parseJsLocation, activityKind } from '../src/energy/gecko-evidence.js';

/** pWh for an energy in joules: the counters' own unit. */
const pwh = (j: number) => j / 3.6e-9;

/** A counter sampled every `every` ms from `from` to `to` (process time), at `watts(t)`. */
function samples(from: number, to: number, every: number, watts: (t: number) => number): number[][] {
  const rows: number[][] = [];
  for (let t = from + every; t <= to; t += every) rows.push([t, pwh(watts(t) * (every / 1000))]);
  return rows;
}
const proc = (startTime: number, rows: number[][], name = 'Process Power', processes: unknown[] = []) => ({
  meta: { startTime },
  counters: [{ name, category: 'power', samples: { schema: { time: 0, count: 1 }, data: rows } }],
  processes,
});

const T0 = 1_700_000_000_000;

describe('buildTimeline', () => {
  it('sums processes on their own clocks, and its bins add up to the step totals', () => {
    // Parent from T0 at 1 W; content process starts 500 ms later, at 2 W.
    const profile = proc(T0, samples(0, 4_000, 10, () => 1), 'Process Power', [proc(T0 + 500, samples(0, 3_500, 10, () => 2))]);
    const sel = selectPowerUnits(collectPowerUnits(profile));
    const windows: WindowRecord[] = [{ label: 'run:0:load', startedAt: T0 + 1_000, endedAt: T0 + 3_000 }];
    const t = buildTimeline(sel, windows, { binMs: 250 })!;
    expect(t.schema).toBe('energy-timeline/1');
    expect(t.binMs).toBe(250);
    expect(t.bins).toHaveLength(8);
    for (const b of t.bins) expect(b.averagePowerW).toBeCloseTo(3, 6);
    const total = t.bins.reduce((a, b) => a + (b.energyJ ?? 0), 0);
    expect(total).toBeCloseTo(energyInWindow(sel.units, T0 + 1_000, T0 + 3_000).joules, 9);
    expect(t.resolution).toMatchObject({ sampleIntervalMs: 10, counterUpdateMs: 10, minimumBinMs: 20, supportedBinsMs: [100, 250, 500, 1000] });
    expect(t.samples.excluded['outside-recorded-windows']).toBeGreaterThan(0);
    expect(t.warnings).toEqual([]);
  });

  it('does not offer bins finer than the counters move', () => {
    // Sampled every 10 ms, but the counter only moves every 100 ms.
    const rows = samples(0, 3_000, 10, () => 0).map(([t]) => [t!, t! % 100 === 0 ? pwh(0.1) : 0]);
    const t = buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, rows))), [{ label: 'run:0:idle', startedAt: T0, endedAt: T0 + 3_000 }], { binMs: 100 })!;
    expect(t.resolution.counterUpdateMs).toBe(100);
    expect(t.resolution.minimumBinMs).toBe(200);
    expect(t.resolution.supportedBinsMs).toEqual([250, 500, 1000]);
    expect(t.binMs).toBe(250);
    expect(t.requestedBinMs).toBe(100);
    expect(t.warnings[0]).toMatch(/finer than these counters resolve/);
  });

  it('keeps missing samples missing, and does not derive power across a gap', () => {
    // A counter at 1 W, silent from 1,000 to 2,000 ms; the first sample after carries the gap's energy.
    const rows = samples(0, 3_000, 10, () => 1).filter(([t]) => t! <= 1_000 || t! > 2_000);
    rows.find(([t]) => t! > 2_000)![1] = pwh(1.01);
    const t = buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, rows))), [{ label: 'run:0:idle', startedAt: T0, endedAt: T0 + 3_000 }], { binMs: 250 })!;
    const silent = t.bins.filter((b) => b.startMs >= 1_000 && b.endMs <= 2_000);
    expect(silent).toHaveLength(4);
    for (const b of silent) expect(b).toMatchObject({ energyJ: null, averagePowerW: null, samples: 0, flags: ['no-samples'] });
    const after = t.bins.find((b) => b.startMs === 2_000)!;
    expect(after.energyJ).toBeGreaterThan(1);
    expect(after.averagePowerW).toBeNull();
    expect(after.flags).toContain('lumped');
    expect(t.gaps).toEqual([{ startMs: 1_000, endMs: 2_010, counter: 0 }]);
    expect(t.warnings.join(' ')).toMatch(/1 gap/);
  });

  it('leaves out unusable samples and says how many', () => {
    const rows = samples(0, 1_000, 10, () => 1);
    rows[3]![1] = -5;
    rows[4]![1] = Number.NaN;
    const t = buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, rows))), [{ label: 'run:0:load', startedAt: T0, endedAt: T0 + 1_000 }])!;
    expect(t.samples.excluded).toMatchObject({ 'negative-energy': 1, 'not-a-number': 1 });
    expect(t.warnings.join(' ')).toMatch(/not usable/);
  });

  it('is undefined with no samples: no timeline is invented', () => {
    expect(buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, []))), [])).toBeUndefined();
  });

  it('labels the baseline, loading, stabilizing, idle and interaction phases', () => {
    const phases = phasesFrom(
      [
        { label: 'run:0:idle', startedAt: T0 + 8_000, endedAt: T0 + 18_000 },
        { label: '__baseline__', startedAt: T0, endedAt: T0 + 5_000 },
        { label: 'run:0:load', startedAt: T0 + 5_500, endedAt: T0 + 7_500, actionEndedAt: T0 + 6_200 },
        { label: 'warmup:0:open menu', startedAt: T0 + 19_000, endedAt: T0 + 19_400 },
      ],
      T0,
    );
    expect(phases.map((p) => [p.kind, p.step, p.startMs, p.endMs, p.warmup])).toEqual([
      ['baseline', 'idle baseline', 0, 5_000, false],
      ['loading', 'load', 5_500, 6_200, false],
      ['stabilizing', 'load', 6_200, 7_500, false],
      ['idle', 'idle', 8_000, 18_000, false],
      ['interaction', 'open menu', 19_000, 19_400, true],
    ]);
  });

  it('places bins in phases, flags boundaries, and rebins without inventing energy', () => {
    const profile = proc(T0, samples(0, 4_000, 10, () => 1));
    const windows = [
      { label: '__baseline__', startedAt: T0, endedAt: T0 + 1_000 },
      { label: 'run:0:load', startedAt: T0 + 1_100, endedAt: T0 + 2_000 },
      { label: 'run:0:idle', startedAt: T0 + 2_000, endedAt: T0 + 4_000 },
    ];
    const t = buildTimeline(selectPowerUnits(collectPowerUnits(profile)), windows, { binMs: 250 })!;
    expect(t.bins[0]!.phase).toBe(0);
    expect(t.bins.find((b) => b.startMs === 1_000)!.flags).toContain('phase-boundary');
    expect(t.phases[t.bins.at(-1)!.phase!]!.kind).toBe('idle');
    expect(phaseEnergy(t, 2)).toBeCloseTo(2, 6);
    const coarse = rebin(t, 1_000);
    expect(coarse.bins).toHaveLength(4);
    expect(coarse.bins.reduce((a, b) => a + (b.energyJ ?? 0), 0)).toBeCloseTo(t.bins.reduce((a, b) => a + (b.energyJ ?? 0), 0), 9);
    expect(rebin(t, 300)).toBe(t); // not a multiple: unchanged
  });

  it('warns when the counters cover the whole machine, and when stacks were sampled', () => {
    const profile = proc(T0, samples(0, 1_000, 10, () => 5), 'Power: CPU package');
    const t = buildTimeline(selectPowerUnits(collectPowerUnits(profile)), [{ label: 'run:0:load', startedAt: T0, endedAt: T0 + 1_000 }], { profilerFeatures: ['power', 'js', 'cpu'] })!;
    expect(t.scope).toBe('cpu-package');
    expect(t.warnings.join(' ')).toMatch(/every process on the machine/);
    expect(t.warnings.join(' ')).toMatch(/stack sampling adds work/);
  });
});

describe('detectSpikes', () => {
  // A deterministic wobble of ±0.02 W, so the spread is not zero.
  const wobble = (t: number) => ((Math.floor(t / 250) % 4) - 1.5) * 0.0133;
  const page = (t: number) => {
    if (t > 6_000 && t <= 7_500) return 3; // 1.5 s plateau at 3 W
    if (t > 9_000 && t <= 9_500) return 5; // 0.5 s peak at 5 W
    if (t > 11_000 && t <= 11_250) return 6; // a single 250 ms bin
    return 1 + wobble(t);
  };
  const windows = [
    { label: '__baseline__', startedAt: T0, endedAt: T0 + 4_000 },
    { label: 'run:0:load', startedAt: T0 + 4_500, endedAt: T0 + 5_500, actionEndedAt: T0 + 5_000 },
    { label: 'run:0:idle', startedAt: T0 + 5_500, endedAt: T0 + 14_000 },
  ];
  const timeline = (watts = page) => buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, samples(0, 14_000, 10, watts)))), windows, { binMs: 250 })!;

  it('finds sustained and brief intervals against the idle baseline, ranked by excess energy', () => {
    const r = detectSpikes(timeline());
    expect(r.method).toBe('robust-threshold-v1');
    expect(r.reference).toMatchObject({ kind: 'baseline-window', bins: 16, spreadFrom: 'mad' });
    expect(r.reference.powerW).toBeCloseTo(1, 1);
    expect(r.intervals.map((i) => [i.id, i.startMs, i.endMs, i.shape])).toEqual([
      ['spike-1', 6_000, 7_500, 'sustained'],
      ['spike-2', 9_000, 9_500, 'brief-peak'],
    ]);
    const [plateau, peak] = r.intervals;
    expect(plateau!.excessEnergyJ).toBeCloseTo(3, 1); // 1.5 s × 2 W above
    expect(peak!.excessEnergyJ).toBeCloseTo(2, 1); // 0.5 s × 4 W above
    expect(peak!.peakPowerW).toBeGreaterThan(plateau!.peakPowerW);
    expect(plateau!.phases).toEqual(['idle']);
    expect(plateau!.steps).toEqual(['run:0:idle']);
    // The single bin is too short for an interval, but is the highest bin.
    expect(r.topBins[0]).toMatchObject({ startMs: 11_000, phase: 'idle' });
    expect(r.statement).toMatch(/not defects/);
    expect(r.settings).toMatchObject({ k: 3.5, binMs: 250, minDurationMs: 500, mergeGapMs: 250, sustainedMs: 1_000 });
  });

  it('reports nothing when power only wobbles', () => {
    const r = detectSpikes(timeline((t) => 1 + wobble(t)));
    expect(r.intervals).toEqual([]);
  });

  it('falls back to the quietest bins without a baseline, and says so', () => {
    const noBaseline = buildTimeline(selectPowerUnits(collectPowerUnits(proc(T0, samples(0, 14_000, 10, page)))), windows.slice(1), { binMs: 250 })!;
    const r = detectSpikes(noBaseline);
    expect(r.reference.kind).toBe('quiet-bins');
    expect(r.warnings.join(' ')).toMatch(/No usable idle baseline/);
    // Time zero is now the load window's start, 4.5 s in.
    expect(r.intervals[0]).toMatchObject({ startMs: 1_500, endMs: 3_000, shape: 'sustained' });
  });

  it('uses the smallest resolved step when the reference barely varies, and says when it does not vary at all', () => {
    // Mostly exactly 1 W (a MAD of zero), with every fourth bin 4 mW higher.
    const r = detectSpikes(timeline((t) => (t > 6_000 && t <= 7_000 ? 2 : (Math.ceil(t / 250) - 1) % 4 === 0 ? 1.004 : 1)));
    expect(r.reference.spreadFrom).toBe('quantum');
    expect(r.reference.spreadW).toBeCloseTo(0.004, 6);
    expect(r.warnings.join(' ')).toMatch(/MAD of zero/);
    expect(r.intervals).toHaveLength(1);
    const flat = detectSpikes(timeline((t) => (t > 6_000 && t <= 7_000 ? 2 : 1)));
    expect(flat.reference.spreadFrom).toBe('none');
    expect(flat.warnings.join(' ')).toMatch(/no spread could be estimated/);
    expect(flat.intervals).toHaveLength(1);
  });

  it('a rise floor and a longer minimum are settings, recorded with the result', () => {
    const r = detectSpikes(timeline(), { minRiseW: 3, minDurationMs: 1_000 });
    expect(r.intervals).toEqual([]);
    expect(r.statement).toMatch(/at least 3 W/);
    expect(detectSpikes(timeline(), { reference: 'rolling' }).warnings.join(' ')).toMatch(/rolling reference rises/);
  });

  it('flags intervals outside measured steps', () => {
    const r = detectSpikes(timeline((t) => (t > 4_000 && t <= 4_500 ? 4 : 1 + wobble(t))));
    expect(r.intervals[0]).toMatchObject({ startMs: 4_000, flags: ['outside-measured-steps'], phases: ['unmeasured'] });
  });
});

describe('geckoEvidence', () => {
  const strings = ['GCMajor', 'Styles', 'Reflow', 'RefreshDriverTick', 'Load 7: https://a.org/js/chart.js', 'DOMEvent', 'frame (https://a.org/js/chart.js:3:10)', 'js::RunScript', 'Idle'];
  const thread = {
    name: 'GeckoMain',
    stringTable: strings,
    markers: {
      schema: { name: 0, startTime: 1, endTime: 2, phase: 3, category: 4, data: 5 },
      data: [
        [0, 1_100, 1_130, 1, 0, { type: 'GCMajor' }],
        [1, 1_200, 1_205, 1, 0, null],
        [2, 1_300, 1_310, 1, 0, null],
        [3, 1_400, 1_416, 1, 0, null],
        [3, 1_420, 1_436, 1, 0, null],
        [4, 1_000, 1_500, 1, 0, { type: 'Network', URI: 'https://a.org/js/chart.js' }],
        [5, 1_450, null, 0, 0, { type: 'DOMEvent', eventType: 'click' }],
        [1, 5_000, 5_010, 1, 0, null], // outside the window
      ],
    },
    samples: { schema: { stack: 0, time: 1, threadCPUDelta: 2 }, data: [[1, 1_200, 9_000], [1, 1_210, 9_000], [2, 1_220, 9_000], [0, 6_000, 9_000]] },
    stackTable: { schema: { prefix: 0, frame: 1, category: 2 }, data: [[null, 0, 1], [0, 1, 1], [0, 2, 0]] },
    frameTable: { schema: { location: 0, line: 1, category: 2 }, data: [[7, null, 1], [6, 3, 1], [8, null, 0]] },
  };
  const profile = { meta: { startTime: T0, categories: [{ name: 'Idle' }, { name: 'JavaScript' }] }, threads: [], processes: [{ meta: { startTime: T0 }, threads: [thread] }] };

  it('reads markers, scripts, requests and events in the interval, on the process clock', () => {
    const e = geckoEvidence(profile, T0 + 1_000, T0 + 1_500, { startEpochMs: T0, endEpochMs: T0 + 7_000 });
    expect(e.available).toEqual({ markers: true, stacks: true, cpuTime: true });
    const kinds = Object.fromEntries(e.activity.map((a) => [a.kind, a.count]));
    expect(kinds).toMatchObject({ 'garbage-collection': 1, style: 1, layout: 1, 'refresh-tick': 2, network: 1, 'dom-event': 1 });
    expect(e.scripts).toEqual([{ url: 'https://a.org/js/chart.js', functionName: 'frame', line: 3, samples: 2 }]);
    expect(e.requests).toEqual([{ url: 'https://a.org/js/chart.js', count: 1 }]);
    expect(e.domEvents).toEqual([{ type: 'click', count: 1 }]);
    expect(e.categories[0]).toMatchObject({ category: 'JavaScript', share: 1 });
    expect(e.categories[0]!.sessionShare).toBeDefined();
  });

  it('says what is unavailable instead of reporting none', () => {
    const bare = { meta: { startTime: T0 }, threads: [{ name: 'GeckoMain' }] };
    const e = geckoEvidence(bare, T0, T0 + 1_000);
    expect(e.available).toEqual({ markers: false, stacks: false, cpuTime: false });
    expect(e.notes.join(' ')).toMatch(/unavailable here, not absent/);
    expect(e.notes.join(' ')).toMatch(/"js" feature/);
  });

  it('parses script locations and classifies markers', () => {
    expect(parseJsLocation('draw (https://a.org/js/chart.js:12:4)')).toEqual({ url: 'https://a.org/js/chart.js', functionName: 'draw', line: 12 });
    expect(parseJsLocation('https://a.org/js/x.js:5:1')).toEqual({ url: 'https://a.org/js/x.js', line: 5 });
    expect(parseJsLocation('js::RunScript')).toBeUndefined();
    expect(activityKind('Rasterize')).toBe('composite');
    expect(activityKind('Something', undefined, 'GC / CC')).toBe('garbage-collection');
    expect(activityKind('Unknown thing')).toBe('other');
  });
});
