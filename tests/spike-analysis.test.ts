/**
 * From intervals to leads, on the fixture site's recorded structure and its
 * real Chromium traces. The intervals and the profiler evidence are built by
 * hand here (no energy hardware in CI): they stand in for a diagnose run, and
 * the tests check how they are tied to components, not any energy figure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFamilies } from '../src/analysis/families.js';
import { buildGraph } from '../src/model/graph.js';
import { linkSpikes, describeInterval, experimentOptions, type TimelineAnalysis } from '../src/energy/spike-analysis.js';
import type { SpikeInterval, SpikeReport } from '../src/energy/spikes.js';
import type { GeckoEvidence } from '../src/energy/gecko-evidence.js';
import type { BenchmarkResult } from '../src/core/types.js';
import type { TraceRecord } from '../src/trace/run.js';
import type { GraphInstance } from '../src/model/graph.js';

const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.families = buildFamilies(r.scenarios);
  r.traces = JSON.parse(readFileSync('tests/fixtures/fixture-site-traces.json', 'utf8')) as TraceRecord[];
  r.graph = buildGraph(r)!;
  return r;
};
const SITE = 'http://www.site.test:8082';

const interval = (o: Partial<SpikeInterval>): SpikeInterval => ({
  id: 'spike-1', rank: 1, startMs: 6_000, endMs: 7_500, durationMs: 1_500, bins: 6, peakPowerW: 3.1, peakAtMs: 6_500, meanPowerW: 2.9, energyJ: 4.35, excessEnergyJ: 2.85,
  referenceW: 1, thresholdW: 1.2, shape: 'sustained', phases: ['idle'], steps: ['run:0:idle'], flags: [], ...o,
});
const analysis = (intervals: SpikeInterval[], evidence?: Record<string, GeckoEvidence>): TimelineAnalysis => ({
  timeline: {} as TimelineAnalysis['timeline'],
  spikes: { intervals } as SpikeReport,
  ...(evidence ? { evidence } : {}),
});
const gecko = (o: Partial<GeckoEvidence>): GeckoEvidence => ({
  source: 'same-run-gecko', available: { markers: true, stacks: true, cpuTime: true }, activity: [], scripts: [], requests: [], domEvents: [], categories: [], notes: [], ...o,
});

describe('linkSpikes', () => {
  const r = fixture();

  it('ties an idle interval on /articles/d to the chart’s script, in the same run and in the trace', () => {
    const ev = gecko({
      scripts: [{ url: `${SITE}/js/chart.js`, functionName: 'frame', line: 2, samples: 40 }],
      activity: [{ kind: 'refresh-tick', count: 90, ms: 300, names: ['RefreshDriverTick'] }, { kind: 'paint', count: 90, ms: 120, names: ['Paint'] }],
    });
    const leads = linkSpikes(r, analysis([interval({})], { 'spike-1': ev }), `${SITE}/articles/d`);
    const lead = leads['spike-1']!;
    const chart = lead.scripts.find((s) => s.url.endsWith('/js/chart.js'))!;
    expect(chart.resource).toMatch(/^rs-[0-9a-f]{8}$/);
    expect(chart.functions).toEqual([{ name: 'frame', line: 2, samples: 40 }]);
    expect(chart.evidence.map((e) => e.class)).toEqual(expect.arrayContaining(['profiler-correlation', 'cross-run-trace']));
    expect(lead.activity).toEqual(['refresh tick: 90 markers, 300 ms (RefreshDriverTick)', 'paint: 90 markers, 120 ms (Paint)']);
    expect(lead.unattributed.some((u) => /do not name the elements/.test(u.reason))).toBe(true);
    expect(lead.caveats.join(' ')).toMatch(/separate run in another browser, matched by page and phase/);
    expect(lead.observed).toBe(describeInterval(interval({})));
  });

  it('lists a component with an endless animation as inferred for an idle interval, never as measured', () => {
    const leads = linkSpikes(r, analysis([interval({})]), `${SITE}/spinner`);
    const spinner = leads['spike-1']!.components.find((c) => c.signature.includes('spinner'))!;
    expect(spinner.classes).toContain('inferred');
    expect(spinner.evidence.find((e) => e.class === 'inferred')!.detail).toMatch(/not tied to this interval/);
    expect(spinner.experiments.find((e) => e.kind === 'remove')!.available).toBe(true);
    expect(spinner.experiments.find((e) => e.kind === 'pause-animations')!.available).toBe(true);
    // Without the run's profile, the interval says what it could not read.
    expect(leads['spike-1']!.unattributed.some((u) => /profile was not read/.test(u.reason))).toBe(true);
  });

  it('matches trace evidence by phase: a load interval gets load findings, not idle ones', () => {
    const load = linkSpikes(r, analysis([interval({ phases: ['loading'], steps: ['run:0:load'] })]), `${SITE}/compute`)['spike-1']!;
    const compute = load.scripts.find((s) => s.url.endsWith('/js/compute.js'));
    expect(compute).toBeDefined();
    expect(compute!.evidence[0]!.detail).toMatch(/long task/i);
    // compute.js is loaded from the head: a page-wide script, tied to no component.
    expect(compute!.loadedBy).toEqual([]);
    const idle = linkSpikes(r, analysis([interval({})]), `${SITE}/compute`)['spike-1']!;
    expect(idle.scripts.some((s) => s.url.endsWith('/js/compute.js'))).toBe(false);
  });

  it('says a script the page did not record is unattributed, and why', () => {
    const ev = gecko({ scripts: [{ url: 'https://elsewhere.example/x.js', samples: 3 }] });
    const lead = linkSpikes(r, analysis([interval({})], { 'spike-1': ev }), `${SITE}/light`)['spike-1']!;
    expect(lead.unattributed).toContainEqual({ what: 'https://elsewhere.example/x.js', reason: expect.stringMatching(/Not among the resources Firefox recorded/) });
  });

  it('says so when there is no graph at all', () => {
    const bare = { ...fixture(), graph: undefined };
    const lead = linkSpikes(bare, analysis([interval({})]), `${SITE}/light`)['spike-1']!;
    expect(lead.components).toEqual([]);
    expect(lead.unattributed.map((u) => u.reason).join(' ')).toMatch(/No component graph/);
  });

  it('never offers to remove the document itself', () => {
    const body = { id: 'ci-00000000', type: 'ct-00000000', page: 'pg-00000000', occurrence: 0, children: [], selector: 'body', tag: 'body', inclusiveNodes: 10, own: { nodes: 10 }, ownEstimated: false, resources: [], ref: { scenario: 0, instance: 0 } } as GraphInstance;
    const opts = experimentOptions(body, [], []);
    expect(opts.filter((o) => ['remove', 'remove-before-load', 'hide'].includes(o.kind)).every((o) => !o.available)).toBe(true);
  });
});
