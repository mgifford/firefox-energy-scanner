import { describe, it, expect } from 'vitest';
import { parseSpec, buildReport, summarizeExperiment, activityFindings, emptySide, type SideState } from '../src/experiments/experiment.js';
import { removalApplied, validateVariant, type VariantProbe } from '../src/experiments/variants.js';
import { namesDocumentStructure, selectorParts, essentialContent, type RemovalCheckpoint, type RemovalProbe, type SubtreeContent } from '../src/experiments/dom-removal.js';
import { specFromQueue } from '../src/experiments/from-queue.js';
import { experimentSection } from '../src/report/experiment-html.js';
import { experimentCsv } from '../src/report/experiment-csv.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';
import type { InvestigationItem } from '../src/analysis/investigation.js';

const content = (o: Partial<SubtreeContent> = {}): SubtreeContent => ({
  elements: 12, headings: 0, landmarks: 0, interactive: 0, formControls: 0, images: 1, media: 0, iframes: 0, canvases: 0, liveRegions: 0, textChars: 40, ...o,
});
const cp = (o: Partial<RemovalCheckpoint> = {}): RemovalCheckpoint => ({
  matched: 1, roots: 1, nested: 0, removed: 1, remaining: 0, identities: [{ tag: 'div', componentId: 'hero-carousel', nodes: 12 }], content: content(), ...o,
});
const probeAfter = (o: Partial<RemovalProbe> = {}): RemovalProbe => ({ matchesNow: 0, reinsertions: 0, rootsReconnected: 0, ...o });
const vprobe = (o: Partial<VariantProbe> = {}): VariantProbe => ({
  matched: 0, runningAnimations: 0, hidden: 0, reducedMotion: false, lazyImages: 0, playingVideos: 0, landmarks: 4, headings: 3, imagesWithoutAlt: 0, focusable: 20, ...o,
});
const act = (timers: number, frames: number, ms = 12_000, running: [number, number] = [0, 0]) => ({ ms, timeouts: 0, intervals: timers, animationFrames: frames, runningAnimations: running });

function side(apply: boolean, runs: number, o: { cp?: Partial<RemovalCheckpoint>; probe?: Partial<RemovalProbe>; failures?: string[]; activity?: ReturnType<typeof act> } = {}): SideState {
  return {
    ...emptySide(),
    runs,
    probes: [vprobe()],
    assertionFailures: o.failures ?? [],
    removals: Array.from({ length: runs }, () => cp({ removed: apply ? 1 : 0, remaining: apply ? 0 : 1, ...o.cp })),
    removalProbes: Array.from({ length: runs }, () => probeAfter({ matchesNow: apply ? 0 : 1, ...o.probe })),
    activity: o.activity ? Array.from({ length: runs }, () => o.activity!) : [],
  };
}

function step(scenario: string, name: string, mwh: number | undefined, i: number): StepResult {
  return {
    scenario, step: name, run: i, warmup: false, url: 'https://a.org/', startedAt: 0, endedAt: 1, timing: { durationMs: 1000 },
    network: { requests: 1, transferBytes: 10_000, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {} },
    ...(mwh !== undefined ? { energy: { raw: { adapterId: 'x', measurementType: 'hardware-estimate', measurementScope: 'process', attribution: 'time-window', durationMs: 1000, sampleCount: 100 }, incrementalJoules: mwh * 3.6 } as StepResult['energy'] } : {}),
    valid: true, warnings: [],
  };
}
const around = (centre: number, n: number) => Array.from({ length: n }, (_, i) => centre + ((i % 5) - 2) * 0.001);
const series = (scenario: string, load: (number | undefined)[], idle: (number | undefined)[]) => [
  ...load.map((v, i) => step(scenario, 'load', v, i)),
  ...idle.map((v, i) => step(scenario, 'idle', v, i)),
];

const spec = parseSpec({ name: 'hero', url: 'https://a.org/', kind: 'remove', selector: '[data-component-id="hero-carousel"]', assertions: [{ role: 'main' }] });

describe('remove: the spec', () => {
  it('fills the removal defaults', () => {
    expect(spec).toMatchObject({ kind: 'remove', idle_ms: 10_000, settle_ms: 2_000 });
  });

  it('refuses what cannot be a removal experiment', () => {
    const base = { name: 'x', url: 'https://a.org/', kind: 'remove' };
    expect(() => parseSpec(base)).toThrow(/needs a selector/);
    expect(() => parseSpec({ ...base, selector: 'body' })).toThrow(/names the document itself/);
    expect(() => parseSpec({ ...base, selector: '.x, html' })).toThrow(/names the document itself/);
    expect(() => parseSpec({ ...base, selector: '.x', journey: 'j.js' })).toThrow(/a journey has no point/);
    expect(() => parseSpec({ ...base, selector: '.x', idle_ms: 0 })).toThrow(/at least 1000/);
    expect(() => parseSpec({ ...base, selector: '.x', max_matches: 0 })).toThrow();
    expect(() => parseSpec({ ...base, selector: '</style>' })).toThrow(/cannot be used/);
    expect(validateVariant({ kind: 'remove', selector: '.a', maxMatches: 501 })[0]).toMatch(/max_matches/);
  });

  it('splits selector lists outside brackets and quotes', () => {
    expect(selectorParts('a, b[title="x, y"], :is(c, d)')).toEqual(['a', 'b[title="x, y"]', ':is(c, d)']);
    expect(namesDocumentStructure(':root')).toBe(true);
    expect(namesDocumentStructure('*')).toBe(true);
    expect(namesDocumentStructure('body > main')).toBe(false);
  });
});

describe('remove: did it apply, and hold?', () => {
  const v = { kind: 'remove' as const, selector: '.hero', maxMatches: 24 };
  const s = (x: SideState) => ({ counts: x.counts, removals: x.removals, removalProbes: x.removalProbes });

  it('is applied only when every variant run removed it and it stayed removed', () => {
    const r = removalApplied(v, s(side(false, 3)), s(side(true, 3)));
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/^Removed 1 subtree .*in each of 3 variant runs; none came back/);
  });

  it('counts nested matches once', () => {
    const r = removalApplied(v, s(side(false, 2, { cp: { matched: 5, nested: 4 } })), s(side(true, 2, { cp: { matched: 5, nested: 4 } })));
    expect(r.note).toMatch(/4 further matches sat inside them/);
  });

  it('a refused removal is not applied, and says why', () => {
    const refused = side(true, 1, { cp: { refused: 'too-broad', refusedDetail: 'The selector matches 400 elements, more than the limit of 24.', removed: 0, remaining: 400, matched: 400 } });
    const r = removalApplied(v, s(side(false, 1)), s(refused));
    expect(r).toEqual({ ok: false, note: 'Removal refused, nothing was removed: The selector matches 400 elements, more than the limit of 24.' });
  });

  it('a component the page put back is not a removal', () => {
    const back = side(true, 3, { probe: { matchesNow: 1, reinsertions: 2, firstReinsertionMs: 210, rootsReconnected: 1 } });
    const r = removalApplied(v, s(side(false, 3)), s(back));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/put the component back in 3 variant runs of 3, the first time 210 ms after/);
  });

  it('leftovers, missing probes and missing checkpoints are not applied', () => {
    expect(removalApplied(v, s(side(false, 1)), s(side(true, 1, { cp: { remaining: 2 } }))).note).toMatch(/still matched/);
    expect(removalApplied(v, s(side(false, 1)), s({ ...side(true, 1), removalProbes: [] })).note).toMatch(/could not be checked/);
    expect(removalApplied(v, s(side(false, 1)), s({ ...side(true, 1), removals: [] })).ok).toBe(false);
  });

  it('notes when the sides were in different states at the checkpoint', () => {
    expect(removalApplied(v, s(side(false, 1, { cp: { matched: 2, roots: 2 } })), s(side(true, 1))).note).toMatch(/not in the same state/);
  });
});

describe('remove: the report', () => {
  const steps = { a: series('baseline', around(0.5, 10), around(0.1, 10)), b: series('variant', around(0.5, 10), around(0.06, 10)) };

  it('reports the idle window as the effect, and the load step as a negative control', () => {
    const r = buildReport(spec, { a: side(false, 10), b: side(true, 10) }, steps, 's', ['a', 'b']);
    expect(r.applied.ok).toBe(true);
    const load = r.differences.find((d) => d.step === 'load')!;
    const idle = r.differences.find((d) => d.step === 'idle')!;
    expect(load.role).toBe('negative-control');
    expect(load.reading).toMatch(/^Negative control/);
    expect(idle).toMatchObject({ role: 'attributable', verdict: 'lower' });
    expect(r.workload).toMatchObject({ kind: 'load-checkpoint-idle', settleMs: 2_000, idleMs: 10_000 });
    expect(r.removal).toMatchObject({ mode: 'post-load', verified: true, reinserted: false, selector: '[data-component-id="hero-carousel"]' });
    expect(r.limitations.join(' ')).toMatch(/does not stop the timers, animation-frame loops, workers/);
    expect(r.limitations.join(' ')).toMatch(/load step is a negative control, never a saving/);
    expect(r.likeForLike).toEqual({ ok: true, reasons: [] });
  });

  it('flags a negative control that moved', () => {
    const moved = { a: series('baseline', around(0.5, 10), around(0.1, 10)), b: series('variant', around(0.3, 10), around(0.06, 10)) };
    const r = buildReport(spec, { a: side(false, 10), b: side(true, 10) }, moved, 's', ['a', 'b']);
    expect(r.limitations.join(' ')).toMatch(/negative control differed \(load: lower\)/);
  });

  it('never reports a difference from a removal that did not hold: no saving is claimed, and none is denied', () => {
    const back = side(true, 10, { probe: { matchesNow: 1, reinsertions: 1, rootsReconnected: 1 } });
    const r = buildReport(spec, { a: side(false, 10), b: back }, steps, 's', ['a', 'b']);
    expect(r.applied.ok).toBe(false);
    expect(r.differences).toEqual([]);
    expect(r.removal!.reinserted).toBe(true);
    const html = experimentSection(r);
    expect(html).toContain('<strong>Applied: no.</strong>');
    expect(html).toContain('not a finding of “no saving”');
    expect(html).not.toContain('<caption>Measured difference');
  });

  it('marks a saving that took away content people use as not like-for-like', () => {
    const essential = content({ headings: 1, interactive: 3, formControls: 1 });
    const r = buildReport(spec, { a: side(false, 10, { cp: { content: essential } }), b: side(true, 10, { cp: { content: essential }, failures: ['role main not visible'] }) }, steps, 's', ['a', 'b']);
    expect(r.likeForLike!.ok).toBe(false);
    expect(r.likeForLike!.reasons.join(' ')).toMatch(/failed checks the baseline passed: role main not visible/);
    expect(r.likeForLike!.reasons.join(' ')).toMatch(/took away 1 heading, 3 interactive controls and links, 1 form control/);
    expect(essentialContent(content())).toEqual([]);
  });

  it('says what script work did after the removal', () => {
    const r = buildReport(spec, { a: side(false, 10, { activity: act(120, 720) }), b: side(true, 10, { activity: act(118, 715) }) }, steps, 's', ['a', 'b']);
    expect(r.removal!.activity.continued).toEqual([
      'timer callbacks: 10.0 a second with the component, 9.8 without',
      'animation-frame callbacks: 60.0 a second with the component, 59.6 without',
    ]);
    expect(r.removal!.activity.note).toMatch(/carried on/);
    const fell = activityFindings(act(120, 0), act(2, 0));
    expect(fell.fell).toEqual(['timer callbacks: 10.0 a second with the component, 0.2 without']);
    expect(activityFindings(act(0, 0), act(0, 0)).note).toMatch(/Little script work/);
    expect(activityFindings(undefined, act(1, 1)).note).toMatch(/not counted/);
  });

  it('keeps time and transfer, and no energy, on a machine without energy', () => {
    const none = { a: series('baseline', [undefined, undefined], [undefined, undefined]), b: series('variant', [undefined, undefined], [undefined, undefined]) };
    const r = buildReport(spec, { a: side(false, 2), b: side(true, 2) }, none, 's', ['a', 'b']);
    expect(r.differences.map((d) => d.verdict)).toEqual(['not-measured', 'not-measured']);
    expect(r.differences.every((d) => d.energy === undefined)).toBe(true);
  });

  it('says no difference was shown when the sides are indistinguishable', () => {
    const same = { a: series('baseline', around(0.5, 10), around(0.1, 10)), b: series('variant', around(0.5, 10), around(0.1004, 10)) };
    const r = buildReport(spec, { a: side(false, 10), b: side(true, 10) }, same, 's', ['a', 'b']);
    expect(r.differences.find((d) => d.step === 'idle')!.verdict).toBe('within-spread');
  });

  it('renders the removal without scripts, and the CSV carries the roles', () => {
    const r = buildReport(spec, { a: side(false, 10, { activity: act(120, 0) }), b: side(true, 10, { activity: act(118, 0) }) }, steps, 's', ['a', 'b']);
    const html = experimentSection(r);
    expect(html).toContain('<h3 id="removal-h">The removal (after the page loaded)</h3>');
    expect(html).toContain('(negative control)');
    expect(html).toContain('<caption>Script work from the checkpoint to the end of idle');
    expect(html).not.toMatch(/<script|<canvas/i);
    const csv = experimentCsv({ experiment: r } as unknown as BenchmarkResult).trim().split('\n');
    expect(csv[0]).toMatch(/,step_role,like_for_like,removal_verified,removal_reinserted$/);
    expect(csv[1]).toMatch(/,negative-control,true,true,false$/);
    expect(csv[2]).toMatch(/,attributable,true,true,false$/);
  });

  it('reads experiment results written before removals and roles existed', () => {
    const old = buildReport(parseSpec({ name: 'c', url: 'https://a.org/', kind: 'pause-animations', selector: '.c' }),
      { a: { ...emptySide(), probes: [vprobe({ runningAnimations: 1, matched: 1 })] }, b: { ...emptySide(), probes: [vprobe({ matched: 1 })] } },
      { a: series('b', around(0.5, 10), around(0.1, 10)), b: series('v', around(0.5, 10), around(0.06, 10)) }, 's', ['a', 'b']);
    const legacy = JSON.parse(JSON.stringify(old));
    delete legacy.removal; delete legacy.likeForLike; delete legacy.workload;
    for (const d of legacy.differences) delete d.role;
    const html = experimentSection(legacy);
    expect(html).toContain('lower with the change');
    expect(html).not.toContain('negative control');
    expect(experimentCsv({ experiment: legacy } as unknown as BenchmarkResult)).toContain(',attributable,,,');
  });

  it('roles default to attributable', () => {
    expect(summarizeExperiment(series('b', [], around(0.1, 3)), series('v', [], around(0.2, 3)))[0]!.role).toBe('attributable');
  });
});

describe('remove: from the investigation queue', () => {
  const item: InvestigationItem = {
    rank: 1, kind: 'component', id: 'cmp-1', title: 'component:carousel', evidence: 'structure', because: [],
    reach: { pages: 1, of: 1, families: 1 }, workload: {}, remediation: [], confidence: 'high',
    where: [{ page: 'https://a.org/', selector: 'div.carousel' }], audits: [],
  };
  const result = { investigation: { method: 'queue-v1', order: [], items: [item], limitations: [] } } as unknown as BenchmarkResult;

  it('scopes a named kind to the item’s selector', () => {
    expect(specFromQueue(result, 1, 'remove').spec).toMatchObject({ kind: 'remove', selector: 'div.carousel', url: 'https://a.org/' });
    expect(() => specFromQueue(result, 1, 'block')).toThrow(/takes remove, hide, pause-animations/);
  });
});

describe('remove-before-load', () => {
  const pre = parseSpec({ name: 'hero-pre', url: 'https://a.org/', kind: 'remove-before-load', selector: '.hero' });
  const steps = { a: series('baseline', around(0.5, 10), around(0.1, 10)), b: series('variant', around(0.3, 10), around(0.06, 10)) };
  const withSnap = (s: SideState, bytes: number): SideState => ({ ...s, snapshots: [{ originalBytes: 50_000, servedBytes: bytes }] });

  it('is its own kind: both load and idle can show its effect', () => {
    expect(pre).toMatchObject({ kind: 'remove-before-load' });
    expect(parseSpec({ name: 'x', url: 'https://a.org/', kind: 'remove-before-load', selector: '.x', idle_ms: 0 }).idle_ms).toBe(0);
    expect(() => parseSpec({ name: 'x', url: 'https://a.org/', kind: 'remove-before-load', selector: 'head' })).toThrow(/names the document itself/);
    const r = buildReport(pre, { a: withSnap(side(false, 10), 49_000), b: withSnap(side(true, 10), 30_000) }, steps, 's', ['a', 'b']);
    expect(r.applied.ok).toBe(true);
    expect(r.applied.note).toMatch(/from the markup before parsing/);
    expect(r.differences.map((d) => [d.step, d.role, d.verdict])).toEqual([['load', 'attributable', 'lower'], ['idle', 'attributable', 'lower']]);
    expect(r.removal).toMatchObject({ mode: 'pre-load', snapshot: { originalBytes: 50_000, servedBytes: [49_000, 30_000] }, settleMs: 0 });
    expect(r.limitations.join(' ')).toMatch(/never combined/);
    expect(r.limitations.join(' ')).toMatch(/snapshot of the document/);
    expect(r.limitations.join(' ')).not.toMatch(/negative control/);
    expect(experimentSection(r)).toContain('The removal (before the page is parsed)');
  });

  it('a component the page’s scripts create anyway is not removed', () => {
    const created = side(true, 3, { probe: { matchesNow: 1, reinsertions: 1, firstReinsertionMs: 40 } });
    const r = removalApplied({ kind: 'remove-before-load', selector: '.hero' }, { counts: emptySide().counts, removals: side(false, 3).removals, removalProbes: side(false, 3).removalProbes }, { counts: created.counts, removals: created.removals, removalProbes: created.removalProbes });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/scripts created the component themselves in 3 variant runs of 3, 40 ms after the document started/);
  });
});

describe('the example removal specs', () => {
  it('parse as written', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    expect(parseSpec(parse(readFileSync('examples/experiments/ticker-remove.yaml', 'utf8')))).toMatchObject({ kind: 'remove', idle_ms: 5_000, settle_ms: 1_000, seed: 'fixture-ticker' });
    expect(parseSpec(parse(readFileSync('examples/experiments/hero-carousel-remove.yaml', 'utf8')))).toMatchObject({ kind: 'remove', max_matches: 4 });
  });
});
