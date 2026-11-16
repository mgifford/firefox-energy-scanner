import { describe, it, expect } from 'vitest';
import { buildReport, emptySide, parseSpec, type SideState } from '../src/experiments/experiment.js';
import { buildEvidenceRecord, findingMarkdown, experimentCommand } from '../src/report/evidence-record.js';
import type { RemovalCheckpoint, SubtreeContent } from '../src/experiments/dom-removal.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';
import type { TimelineAnalysis } from '../src/energy/spike-analysis.js';

const content = (o: Partial<SubtreeContent> = {}): SubtreeContent => ({
  elements: 30, headings: 0, landmarks: 0, interactive: 0, formControls: 0, images: 4, media: 0, iframes: 0, canvases: 0, liveRegions: 0, textChars: 0, ...o,
});
const cp = (apply: boolean, o: Partial<RemovalCheckpoint> = {}): RemovalCheckpoint => ({
  matched: 1, roots: 1, nested: 0, removed: apply ? 1 : 0, remaining: apply ? 0 : 1, identities: [{ tag: 'div', componentId: 'hero-carousel', nodes: 30 }], content: content(), ...o,
});
const side = (apply: boolean, runs: number, o: { content?: SubtreeContent; back?: boolean; failures?: string[]; timers?: number } = {}): SideState => ({
  ...emptySide(),
  runs,
  probes: [{ matched: 0, runningAnimations: 0, hidden: 0, reducedMotion: false, lazyImages: 0, playingVideos: 0, landmarks: 4, headings: 3, imagesWithoutAlt: 0, focusable: 20 }],
  assertionFailures: o.failures ?? [],
  removals: Array.from({ length: runs }, () => cp(apply, o.content ? { content: o.content } : {})),
  removalProbes: Array.from({ length: runs }, () => ({ matchesNow: apply && !o.back ? 0 : 1, reinsertions: o.back ? 1 : 0, rootsReconnected: o.back ? 1 : 0 })),
  activity: o.timers !== undefined ? Array.from({ length: runs }, () => ({ ms: 12_000, timeouts: 0, intervals: o.timers!, animationFrames: 0, runningAnimations: [0, 0] as [number, number] })) : [],
});
function step(scenario: string, name: string, mwh: number | undefined, i: number): StepResult {
  return {
    scenario, step: name, run: i, warmup: false, startedAt: 0, endedAt: 1, timing: { durationMs: 1000 },
    ...(mwh !== undefined ? { energy: { raw: { adapterId: 'x', measurementType: 'hardware-estimate', measurementScope: 'process', attribution: 'time-window', durationMs: 1000, sampleCount: 100 }, incrementalJoules: mwh * 3.6 } as StepResult['energy'] } : {}),
    valid: true, warnings: [],
  };
}
const around = (c: number, n: number) => Array.from({ length: n }, (_, i) => c + ((i % 5) - 2) * 0.001);
const series = (sc: string, load: (number | undefined)[], idle: (number | undefined)[]) => [...load.map((v, i) => step(sc, 'load', v, i)), ...idle.map((v, i) => step(sc, 'idle', v, i))];

const spec = parseSpec({ name: 'hero', url: 'https://a.org/', kind: 'remove', selector: '[data-component-id="hero-carousel"]', assertions: [{ role: 'main' }] });
const result = (a: SideState, b: SideState, steps = { a: series('baseline', around(0.5, 10), around(0.1, 10)), b: series('variant', around(0.5, 10), around(0.06, 10)) }): BenchmarkResult =>
  ({
    schemaVersion: 2,
    session: { id: 's', startedAt: '2026-11-16T00:00:00Z', mode: 'compare' },
    environment: { timestamp: '2026-11-16T00:00:00Z', os: 'darwin', osVersion: '25.0', architecture: 'arm64', cpuCount: 8, totalMemoryBytes: 1, cpuModel: 'Apple M2', firefoxVersion: '153.0', energyAdapter: 'auto', headed: true, viewport: { width: 1440, height: 900 }, onBattery: false },
    capabilities: { tier: 'full', summary: '', unavailable: [], energyCheck: { verdict: 'energy', reason: '', nextSteps: [], scope: 'process' } },
    configuration: { benchmark: { cache_mode: 'warm', warmups: 2 }, energy: { baseline: true, baseline_duration_ms: 10_000, profiler_interval_ms: 10 }, network: { public_only: false } },
    scenarios: [],
    experiment: buildReport(spec, { a, b }, steps, 'seed-1', Array.from({ length: 10 }, () => ['a', 'b'] as const).flat()),
    warnings: [],
  }) as BenchmarkResult;

describe('the evidence record', () => {
  it('keeps the four parts apart, and a supported reduction is not a call to remove', () => {
    const r = buildEvidenceRecord(result(side(false, 10, { timers: 120 }), side(true, 10, { timers: 118 })), { now: '2026-11-16T00:00:00Z' })!;
    expect(r.schema).toBe('energy-finding/1');
    expect(r.id).toMatch(/^fr-[0-9a-f]{8}$/);
    expect(r.outcome).toMatchObject({ status: 'reduction-shown', confidence: 'confirmatory' });
    expect(r.outcome.steps.map((s) => [s.step, s.role, s.verdict])).toEqual([['load', 'negative-control', 'within-spread'], ['idle', 'attributable', 'lower']]);
    expect(r.recommendation.options).toEqual(['optimize', 'defer', 'redesign', 'replace', 'remove']);
    expect(r.recommendation.caution).toMatch(/does not show the component should be removed/);
    expect(r.recommendation.statement).toMatch(/scripts kept working after its markup was gone/);
    expect(r.observed.statements.join(' ')).toMatch(/carried on/);
    expect(r.suspected.statement).toMatch(/chosen for testing/);
    expect(r.experiment.command).toBe(`web-energy experiment https://a.org/ --kind remove --selector '[data-component-id="hero-carousel"]' --idle 10000 --settle 2000 --runs 10 --warmups 2 --seed seed-1`);
    expect(r.environment).toMatchObject({ firefox: '153.0', cpuModel: 'Apple M2', viewport: '1440x900', cacheMode: 'warm', energyScope: 'process', idleBaseline: '10000 ms', onBattery: false });
    expect(r.wsg.mapping).toBe('not-asserted');
    expect(r.topics).toEqual(expect.arrayContaining(['dom-components', 'idle-work', 'timers-and-loops']));
  });

  it('a removal that did not hold is a failed intervention, never "no saving"', () => {
    const r = buildEvidenceRecord(result(side(false, 10), side(true, 10, { back: true })))!;
    expect(r.outcome.status).toBe('intervention-failed');
    expect(r.outcome.statement).toMatch(/not evidence that the change saves nothing/);
    expect(r.outcome.steps).toEqual([]);
    expect(r.recommendation.options).toEqual([]);
  });

  it('a saving that took away content people use is not like-for-like', () => {
    const essential = content({ headings: 2, interactive: 5 });
    const r = buildEvidenceRecord(result(side(false, 10, { content: essential }), side(true, 10, { content: essential, failures: ['role main not visible'] })))!;
    expect(r.outcome.status).toBe('reduction-not-like-for-like');
    expect(r.accessibility.likeForLike.ok).toBe(false);
    expect(r.accessibility.removedContent).toEqual(['2 headings', '5 interactive controls and links']);
    expect(r.recommendation.options).not.toContain('remove');
  });

  it('indistinguishable, unmeasured and indicative results say so', () => {
    const same = result(side(false, 10), side(true, 10), { a: series('b', around(0.5, 10), around(0.1, 10)), b: series('v', around(0.5, 10), around(0.1004, 10)) });
    expect(buildEvidenceRecord(same)!.outcome.status).toBe('no-difference-shown');
    const none = result(side(false, 2), side(true, 2), { a: series('b', [undefined, undefined], [undefined, undefined]), b: series('v', [undefined, undefined], [undefined, undefined]) });
    const n = buildEvidenceRecord(none)!;
    expect(n.outcome).toMatchObject({ status: 'not-measured', confidence: 'none' });
    expect(n.outcome.steps.every((s) => s.baseline === undefined && s.differenceMwh === undefined)).toBe(true);
    const few = result(side(false, 3), side(true, 3), { a: series('b', around(0.5, 3), around(0.1, 3)), b: series('v', around(0.5, 3), around(0.05, 3)) });
    expect(buildEvidenceRecord(few)!.outcome.confidence).toBe('indicative');
  });

  it('takes its observed activity and source files from a diagnose result that names the component', () => {
    const t = {
      leads: {
        'spike-1': {
          spike: 'spike-1', observed: '1.50 s (sustained) from 6.00 s, during idle', activity: ['refresh tick: 90 markers, 300 ms'],
          components: [{ instance: 'ci-1', type: 'ct-1', signature: 'component:hero-carousel', selector: '[data-component-id="hero-carousel"]', page: 'https://a.org/', reach: { pages: 3, families: 1 }, scripts: ['a.org/js/carousel.js'], resources: [], evidence: [{ class: 'profiler-correlation', source: 'same-run-gecko', detail: 'Its script carousel.js was on the stack.' }], classes: ['profiler-correlation'], lighthouse: [], experiments: [] }],
          scripts: [{ url: 'https://a.org/js/carousel.js', resource: 'rs-1', loadedBy: ['ci-1'], functions: [{ name: 'tick', line: 40, samples: 12 }], evidence: [] }],
          unattributed: [], caveats: [],
        },
      },
    } as unknown as TimelineAnalysis;
    const evidence = { timelines: [t] } as unknown as BenchmarkResult;
    const r = buildEvidenceRecord(result(side(false, 10), side(true, 10)), { evidence, evidenceFile: 'diagnose-1.json' })!;
    expect(r.observed.statements[0]).toBe('Profiling (diagnose-1.json): 1.50 s (sustained) from 6.00 s, during idle');
    expect(r.observed.evidence[0]).toMatchObject({ class: 'profiler-correlation' });
    expect(r.suspected.statement).toMatch(/did not show it was the cause/);
    expect(r.target.sourceFiles).toEqual([
      { url: 'https://a.org/js/carousel.js', functions: ['tick:40'], how: 'on the stack during the interval (same run)' },
      { url: 'a.org/js/carousel.js', functions: [], how: 'loaded by the component (component graph)' },
    ]);
    expect(r.artifacts.profiling).toBe('diagnose-1.json');
  });

  it('renders the issue draft with the four parts in order, as plain Markdown', () => {
    const r = buildEvidenceRecord(result(side(false, 10), side(true, 10)), { artifacts: { json: 'x.json' } })!;
    const md = findingMarkdown(r);
    const at = (h: string) => md.indexOf(h);
    expect(at('## 1. Observed activity')).toBeGreaterThan(0);
    expect(at('## 2. Suspected cause')).toBeGreaterThan(at('## 1. Observed activity'));
    expect(at('## 3. Experimentally supported outcome')).toBeGreaterThan(at('## 2. Suspected cause'));
    expect(at('## 4. Recommended production change')).toBeGreaterThan(at('## 3. Experimentally supported outcome'));
    expect(md).toContain('| idle | attributable | 10 / 10 |');
    expect(md).toContain('```sh\nweb-energy experiment');
    expect(md).not.toMatch(/<(?!\/?(?:div|section))[a-z]/i);
  });

  it('is absent for a result without an experiment', () => {
    expect(buildEvidenceRecord({ scenarios: [] } as unknown as BenchmarkResult)).toBeUndefined();
    expect(experimentCommand(result(side(false, 1), side(true, 1)).experiment!, { idle_ms: 5000 })).toMatch(/--idle 5000/);
  });
});
