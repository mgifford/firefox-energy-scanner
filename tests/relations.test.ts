/**
 * The chart fixture's script relationship: /js/chart.js is page-level (its
 * <script> is outside the figure), but the same-run profile has it on the
 * stack and its source names #chart, inside component:live-chart. The graph
 * records that as an observed relationship, never as ownership.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGraph, type ComponentGraph } from '../src/model/graph.js';
import { validateGraph } from '../src/model/schema.js';
import type { BenchmarkResult, ScriptReferenceRecord } from '../src/core/types.js';

const PAGE = 'http://www.site.test:8082/articles/d';
const CHART = 'http://www.site.test:8082/js/chart.js';

const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  for (const s of r.scenarios) {
    for (const i of s.anatomy?.structure?.instances ?? []) {
      if (i.signature === 'component:live-chart') i.domIds = ['chart'];
    }
  }
  return r;
};

const ref = (url: string, refs: ScriptReferenceRecord['refs'], page = PAGE): ScriptReferenceRecord => ({
  url,
  page,
  status: 'scanned',
  bytes: 200,
  refs,
});

const withStack = (r: BenchmarkResult, script = CHART): BenchmarkResult => {
  r.timelines = [
    {
      page: PAGE,
      evidence: {
        'spike-1': {
          source: 'same-run-gecko',
          available: { markers: true, stacks: true, cpuTime: true },
          activity: [],
          scripts: [{ url: script, functionName: 'frame', line: 2, samples: 12, process: 'page' }],
          requests: [],
          domEvents: [],
          categories: [],
          notes: [],
        },
      },
    },
  ] as unknown as BenchmarkResult['timelines'];
  return r;
};

const chartOf = (g: ComponentGraph) => {
  const type = g.types.find((t) => t.signature === 'component:live-chart')!;
  return g.instances.find((i) => i.type === type.id)!;
};
const resourceOf = (g: ComponentGraph, suffix: string) => g.resources.find((r) => r.key.endsWith(suffix))!;

describe('script-to-component relations', () => {
  it('ties chart.js to live-chart by a same-run stack and the script’s #chart reference', () => {
    const r = withStack(fixture());
    r.scriptReferences = [ref(CHART, [{ kind: 'id', value: 'chart' }])];
    const g = buildGraph(r)!;
    const chart = chartOf(g);
    const script = resourceOf(g, '/js/chart.js');
    const rel = (g.relations ?? []).find((x) => x.kind === 'script-observed-with-component' && x.to.id === chart.id)!;

    expect(rel).toBeDefined();
    expect(rel.from).toEqual({ type: 'resource', id: script.id });
    expect(rel).toMatchObject({ source: 'same-run-gecko', evidenceClass: 'profiler-correlation', confidence: 'medium', attributionStatus: 'supported' });
    expect(rel.artifactRef).toMatch(/^timelines\[0\]\.evidence\[spike-1\]\.scripts$/);
    expect(rel.method).toMatch(/#chart/);
    expect((rel.limitations ?? []).join(' ')).toMatch(/not ownership/i);
    // The page's main landmark also contains #chart, but the chart is the more
    // specific recorded component and is the one the reference is about.
    const mainType = g.types.find((t) => t.signature === 'landmark:main')!;
    const main = g.instances.find((i) => i.type === mainType.id && i.page === chart.page)!;
    expect((g.relations ?? []).some((x) => x.kind === 'script-observed-with-component' && x.to.id === main.id)).toBe(false);
    // The page used the script; the chart does not declare it. A container
    // around the page's markup (main) may, which is not ownership by the chart.
    expect((g.relations ?? []).some((x) => x.kind === 'resource-used-on-page' && x.to.id === script.id)).toBe(true);
    expect((g.relations ?? []).some((x) => x.kind === 'declares-resource' && x.to.id === script.id)).toBe(true);
    expect((g.relations ?? []).some((x) => x.kind === 'declares-resource' && x.to.id === script.id && x.from.id === chart.id)).toBe(false);
    expect(validateGraph(g)).toEqual([]);
  });

  it('keeps a static reference without a stack hit as a suspicion, not an observation', () => {
    const r = fixture();
    r.scriptReferences = [ref(CHART, [{ kind: 'id', value: 'chart' }])];
    const g = buildGraph(r)!;
    const chart = chartOf(g);
    const rel = (g.relations ?? []).find((x) => x.to.id === chart.id && x.kind === 'suspected-association')!;
    expect(rel).toMatchObject({ source: 'script-source', evidenceClass: 'structural-heuristic', confidence: 'low', attributionStatus: 'suspected' });
    expect((g.relations ?? []).some((x) => x.kind === 'script-observed-with-component')).toBe(false);
  });

  it('does not assign an unrelated script to the component', () => {
    const r = fixture();
    r.scriptReferences = [ref('http://www.site.test:8082/js/cards.js', [{ kind: 'id', value: 'not-a-component-element' }])];
    const g = buildGraph(r)!;
    expect((g.relations ?? []).filter((x) => x.kind === 'script-observed-with-component' || x.kind === 'suspected-association')).toEqual([]);
  });

  it('adds one edge per component for a shared script, without ownership', () => {
    const r = fixture();
    // Give a second instance the same id: a shared script names it too.
    for (const s of r.scenarios) {
      for (const i of s.anatomy?.structure?.instances ?? []) {
        if (i.signature === 'component:site-header') i.domIds = ['chart', 'header-search'];
      }
    }
    r.scriptReferences = [ref(CHART, [{ kind: 'id', value: 'chart' }, { kind: 'id', value: 'header-search' }])];
    const g = buildGraph(withStack(r))!;
    const edges = (g.relations ?? []).filter((x) => x.kind === 'script-observed-with-component');
    expect(new Set(edges.map((e) => e.to.id)).size).toBe(2);
    expect(edges.some((e) => e.attributionStatus === 'supported')).toBe(true);
    expect(edges.every((e) => e.attributionStatus !== 'owned')).toBe(true);
  });

  it('does not relate a cross-origin or inline script to a component', () => {
    const r = fixture();
    r.scriptReferences = [
      { url: 'http://thirdparty.test/widget.js', page: PAGE, status: 'cross-origin', refs: [] },
      { url: PAGE, page: PAGE, inline: true, status: 'scanned', refs: [{ kind: 'id', value: 'chart' }] },
    ];
    const g = buildGraph(r)!;
    expect((g.relations ?? []).filter((x) => x.kind === 'script-observed-with-component' || x.kind === 'suspected-association')).toEqual([]);
  });

  it('keeps relation ids stable between builds', () => {
    const r = withStack(fixture());
    r.scriptReferences = [ref(CHART, [{ kind: 'id', value: 'chart' }])];
    const a = buildGraph(r)!;
    const b = buildGraph(r)!;
    expect((b.relations ?? []).map((x) => x.id)).toEqual((a.relations ?? []).map((x) => x.id));
  });
});
