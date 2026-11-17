import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectPowerUnits, selectPowerUnits } from '../src/energy/gecko-profile.js';
import { buildTimeline } from '../src/energy/timeline.js';
import { detectSpikes } from '../src/energy/spikes.js';
import { linkSpikes, type TimelineAnalysis } from '../src/energy/spike-analysis.js';
import { buildFamilies } from '../src/analysis/families.js';
import { buildGraph } from '../src/model/graph.js';
import { findingJsonSchema, timelineJsonSchema, validateFinding, validateTimelineAnalysis } from '../src/model/records-schema.js';
import { buildReport, emptySide, parseSpec } from '../src/experiments/experiment.js';
import { buildEvidenceRecord } from '../src/report/evidence-record.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';

const T0 = 1_700_000_000_000;
const pwh = (j: number) => j / 3.6e-9;
function analysis(): TimelineAnalysis {
  const rows: number[][] = [];
  for (let t = 10; t <= 14_000; t += 10) if (!(t > 12_000 && t <= 12_500)) rows.push([t, pwh((t > 6_000 && t <= 7_500 ? 3 : 1 + (((Math.ceil(t / 250) - 1) % 4) - 1.5) * 0.013) * 0.01)]);
  const t = buildTimeline(selectPowerUnits(collectPowerUnits({ meta: { startTime: T0 }, counters: [{ name: 'Process Power', category: 'power', samples: { schema: { time: 0, count: 1 }, data: rows } }] })), [
    { label: '__baseline__', startedAt: T0, endedAt: T0 + 4_000 },
    { label: 'run:0:load', startedAt: T0 + 4_500, endedAt: T0 + 5_500, actionEndedAt: T0 + 5_000 },
    { label: 'run:0:idle', startedAt: T0 + 5_500, endedAt: T0 + 14_000 },
  ])!;
  return { timeline: t, spikes: detectSpikes(t) };
}

describe('the energy timeline schema', () => {
  it('accepts what the code builds, leads included', () => {
    const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
    r.families = buildFamilies(r.scenarios);
    r.traces = JSON.parse(readFileSync('tests/fixtures/fixture-site-traces.json', 'utf8'));
    r.graph = buildGraph(r)!;
    const a = analysis();
    a.leads = linkSpikes(r, a, 'http://www.site.test:8082/spinner');
    expect(validateTimelineAnalysis(JSON.parse(JSON.stringify(a)))).toEqual([]);
  });

  it('refuses a zero for a bin that was not measured, and bins finer than the counters', () => {
    const a = JSON.parse(JSON.stringify(analysis()));
    const empty = a.timeline.bins.find((b: { samples: number }) => b.samples === 0);
    empty.energyJ = 0;
    expect(validateTimelineAnalysis(a).join(' ')).toMatch(/never zero/);
    const b = JSON.parse(JSON.stringify(analysis()));
    b.timeline.binMs = 5;
    expect(validateTimelineAnalysis(b).join(' ')).toMatch(/never finer than the counters resolve/);
  });

  it('is published, and the published file is in step with the code', () => {
    expect(JSON.parse(readFileSync('schema/energy-timeline.schema.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(timelineJsonSchema())));
  });
});

describe('the finding schema', () => {
  const spec = parseSpec({ name: 'h', url: 'https://a.org/', kind: 'remove', selector: '.hero' });
  const step = (sc: string, name: string, mwh: number | undefined, i: number): StepResult => ({
    scenario: sc, step: name, run: i, warmup: false, startedAt: 0, endedAt: 1, timing: { durationMs: 1000 }, valid: true, warnings: [],
    ...(mwh !== undefined ? { energy: { raw: { adapterId: 'x', measurementType: 'hardware-estimate', measurementScope: 'process', attribution: 'time-window', durationMs: 1000, sampleCount: 100 }, incrementalJoules: mwh * 3.6 } as StepResult['energy'] } : {}),
  });
  const side = (apply: boolean, back = false) => ({
    ...emptySide(), runs: 2,
    removals: [0, 1].map(() => ({ matched: 1, roots: 1, nested: 0, removed: apply ? 1 : 0, remaining: apply ? 0 : 1, identities: [], content: { elements: 3, headings: 0, landmarks: 0, interactive: 0, formControls: 0, images: 0, media: 0, iframes: 0, canvases: 0, liveRegions: 0, textChars: 0 } })),
    removalProbes: [0, 1].map(() => ({ matchesNow: apply && !back ? 0 : 1, reinsertions: back ? 1 : 0, rootsReconnected: 0 })),
  });
  const result = (b: ReturnType<typeof side>, mwh: (number | undefined)[]) =>
    ({
      environment: { timestamp: 't', os: 'darwin', osVersion: '1', architecture: 'arm64', cpuCount: 1, totalMemoryBytes: 1, energyAdapter: 'auto', headed: true, viewport: { width: 1, height: 1 } },
      configuration: {},
      scenarios: [],
      experiment: buildReport(spec, { a: side(false), b }, { a: mwh.flatMap((v, i) => [step('b', 'load', v, i), step('b', 'idle', v, i)]), b: mwh.flatMap((v, i) => [step('v', 'load', v, i), step('v', 'idle', v === undefined ? v : v / 2, i)]) }, 's', ['a', 'b', 'a', 'b']),
      warnings: [],
    }) as unknown as BenchmarkResult;

  it('accepts what the code builds: measured, not measured and failed', () => {
    for (const r of [result(side(true), [0.1, 0.11]), result(side(true), [undefined, undefined]), result(side(true, true), [0.1, 0.11])]) {
      expect(validateFinding(JSON.parse(JSON.stringify(buildEvidenceRecord(r))))).toEqual([]);
    }
  });

  it('refuses a figure for an unmeasured step, steps from a failed intervention, and removal as the only advice', () => {
    const none = JSON.parse(JSON.stringify(buildEvidenceRecord(result(side(true), [undefined, undefined]))));
    none.outcome.steps[0].differenceMwh = 0;
    expect(validateFinding(none).join(' ')).toMatch(/carries no energy figure/);
    const failed = JSON.parse(JSON.stringify(buildEvidenceRecord(result(side(true, true), [0.1, 0.11]))));
    failed.outcome.confidence = 'confirmatory';
    expect(validateFinding(failed).join(' ')).toMatch(/compares nothing/);
    const remove = JSON.parse(JSON.stringify(buildEvidenceRecord(result(side(true), [0.1, 0.11]))));
    remove.recommendation.options = ['remove'];
    expect(validateFinding(remove).join(' ')).toMatch(/never the only recommendation/);
    remove.recommendation.options = [];
    remove.wsg.mapping = 'WSG 3.1';
    expect(validateFinding(remove).length).toBeGreaterThan(0);
  });

  it('is published, and the published file is in step with the code', () => {
    expect(JSON.parse(readFileSync('schema/energy-finding.schema.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(findingJsonSchema())));
  });
});
