import { describe, it, expect } from 'vitest';
import { buildSitePatterns } from '../src/analysis/patterns.js';
import type { BenchmarkResult } from '../src/core/types.js';
import type { ComponentGraph, ComponentType, GraphFinding, GraphInstance, GraphPage, GraphResource } from '../src/model/graph.js';
import { patternsSection } from '../src/report/patterns-html.js';

const page = (n: number, family?: string): GraphPage => ({
  id: `pg-${n}`,
  url: `https://example.gov/page-${n}`,
  ...(family ? { family } : {}),
  metrics: {},
  instances: [],
  resources: [],
});
const type = (id: string, signature: string, pages: number, families: string[] = []): ComponentType => ({
  id,
  signature,
  method: 'annotation',
  identification: 'explicit',
  confidence: 'high',
  matchedBy: ['signature'],
  pages,
  families,
  instances: pages,
  inclusiveNodes: { median: 10, max: 10 },
  container: false,
  variants: 1,
  notes: [],
});
const inst = (id: string, typeId: string, pageId: string, resources: string[] = []): GraphInstance => ({
  id,
  type: typeId,
  page: pageId,
  occurrence: 0,
  children: [],
  selector: `[data-component-id="${id}"]`,
  inclusiveNodes: 10,
  own: { nodes: 10 },
  ownEstimated: false,
  resources,
  ref: { scenario: 0, instance: 0 },
});
const resource = (id: string, key: string, pages: number, loadedBy: string[]): GraphResource => ({
  id,
  key,
  host: 'example.gov',
  kind: 'script',
  thirdParty: false,
  pages,
  families: [],
  scope: 'shared',
  transferBytes: { median: 1000, max: 1000 },
  loadedBy,
});
const finding = (id: string, kind: string, pageId: string, target: GraphFinding['target'], evidenceClass: GraphFinding['evidenceClass'] = 'direct-observation'): GraphFinding => ({
  id,
  kind,
  title: kind,
  page: pageId,
  target,
  evidenceClass,
  role: 'finding',
  evidence: [{ source: 'firefox-dom', ref: 'test' }],
  energy: { status: 'not-measured', measuredWorkloadDeltaMwh: null },
});

const graph = (): ComponentGraph => {
  const pages = [page(1, 'pf-a'), page(2, 'pf-a'), page(3, 'pf-a'), page(4, 'pf-b'), page(5, 'pf-b'), page(6, 'pf-b')];
  const types = [
    type('ct-nav', 'component:site-nav', 6, ['pf-a', 'pf-b']),
    type('ct-nav-alt', 'landmark:navigation', 1),
    type('ct-chart', 'component:live-chart', 1),
  ];
  const instances = [
    ...pages.map((p, i) => inst(`ci-nav-${i + 1}`, 'ct-nav', p.id, ['rs-app'])),
    inst('ci-nav-alt', 'ct-nav-alt', 'pg-2', ['rs-app']),
    inst('ci-chart', 'ct-chart', 'pg-1', ['rs-chart']),
  ];
  const resources = [
    resource('rs-app', 'example.gov/js/app.js', 6, instances.filter((i) => i.resources.includes('rs-app')).map((i) => i.id)),
    resource('rs-chart', 'example.gov/js/chart.js', 1, ['ci-chart']),
  ];
  const findings = [
    ...pages.map((p, i) => finding(`fd-nav-${i + 1}`, 'endless-animation', p.id, { type: 'instance', id: `ci-nav-${i + 1}` })),
    finding('fd-alt', 'endless-animation', 'pg-2', { type: 'instance', id: 'ci-nav-alt' }),
    finding('fd-chart', 'trace:continuous-animation-frames', 'pg-1', { type: 'instance', id: 'ci-chart' }, 'trace-supported'),
    finding('fd-js', 'lighthouse:unused-javascript', 'pg-1', { type: 'resource', id: 'rs-app' }, 'resource-association'),
    finding('fd-page-1', 'lighthouse:dom-size-insight', 'pg-1', { type: 'page' }, 'direct-node'),
    finding('fd-page-2', 'lighthouse:dom-size-insight', 'pg-2', { type: 'page' }, 'direct-node'),
  ];
  return { schema: 'component-graph/1', sources: [], pages, types, instances, resources, findings, limitations: [] };
};

const result = (): BenchmarkResult => ({ graph: graph(), scenarios: [], warnings: [] }) as unknown as BenchmarkResult;

describe('site-wide patterns', () => {
  const p = buildSitePatterns(result())!;

  it('groups a shared navigation finding once across its pages and families', () => {
    const nav = p.patterns.find((x) => x.kind === 'endless-animation' && x.target.id === 'ct-nav')!;
    expect(nav).toMatchObject({ pages: 6, families: 2, instances: 6, evidenceClass: 'direct-observation' });
    expect(p.patterns.filter((x) => x.kind === 'endless-animation')).toHaveLength(2); // nav and the different nav type
  });

  it('keeps two different navigation implementations apart', () => {
    const nav = p.patterns.find((x) => x.target.id === 'ct-nav')!;
    const alt = p.patterns.find((x) => x.target.id === 'ct-nav-alt')!;
    expect(nav.id).not.toBe(alt.id);
    expect(alt.pages).toBe(1);
    // A component finding is not a finding about every resource the component loads.
    expect(nav.resourceIds).toEqual([]);
    expect(p.resources.find((r) => r.id === 'rs-app')!.findings.map((f) => f.kind)).not.toContain('endless-animation');
  });

  it('keeps the chart-specific finding separate from the shared navigation one', () => {
    const chart = p.patterns.find((x) => x.kind === 'trace:continuous-animation-frames')!;
    expect(chart.target).toMatchObject({ type: 'component-type', id: 'ct-chart' });
    expect(chart.evidenceClass).toBe('trace-supported');
  });

  it('groups a shared script once with several component edges, not one copy per component', () => {
    const js = p.patterns.find((x) => x.kind === 'lighthouse:unused-javascript')!;
    expect(js.target).toMatchObject({ type: 'resource', id: 'rs-app' });
    expect(new Set(js.componentTypeIds)).toEqual(new Set(['ct-nav', 'ct-nav-alt']));
    const app = p.resources.find((r) => r.id === 'rs-app')!;
    expect(new Set(app.componentTypes.map((c) => c.id))).toEqual(new Set(['ct-nav', 'ct-nav-alt']));
    const nav = p.components.find((c) => c.id === 'ct-nav')!;
    expect(nav.resources.some((r) => r.id === 'rs-app')).toBe(true);
    expect(nav.findings.some((f) => f.kind === 'lighthouse:unused-javascript')).toBe(true);
  });

  it('keeps page-level findings separate, and never reports energy', () => {
    const pageFindings = p.patterns.filter((x) => x.kind === 'lighthouse:dom-size-insight');
    expect(pageFindings).toHaveLength(2);
    expect(pageFindings.every((x) => x.target.type === 'page')).toBe(true);
    expect(p.patterns.every((x) => x.energy === 'not-measured')).toBe(true);
  });

  it('ranks stronger evidence and wider reach first, with visible reasons', () => {
    expect(p.patterns[0]!.evidenceClass).toBe('direct-observation');
    expect(p.patterns.every((x, i) => x.rank === i + 1)).toBe(true);
  });

  it('renders accessible tables without scripts', () => {
    const html = patternsSection(p);
    expect(html).toContain('<h2 id="patterns-h">Site patterns</h2>');
    expect(html).toContain('<caption>Recurring findings, strongest evidence first</caption>');
    expect(html).toContain('<th scope="col">Finding</th>');
    expect(html).not.toMatch(/<script|<canvas|onclick=/i);
  });
});
