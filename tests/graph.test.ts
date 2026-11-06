import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGraph, inferKind, resourceIdentity, type ComponentGraph } from '../src/model/graph.js';
import { graphJsonSchema, validateGraph } from '../src/model/schema.js';
import { migrateResult } from '../src/model/migrate.js';
import { buildFamilies } from '../src/analysis/families.js';
import { buildInventory } from '../src/analysis/components.js';
import { buildInvestigation } from '../src/analysis/investigation.js';
import { resourcesSection } from '../src/report/resources-html.js';
import { resourcesCsv } from '../src/report/resources-csv.js';
import type { BenchmarkResult } from '../src/core/types.js';

/** The fixture site, recorded in Chromium (synthetic; see the file's note). */
const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.families = buildFamilies(r.scenarios);
  return r;
};
/** The Energy.gov scan of issue #37: a real, version 1 result. */
const energyGov = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('site/results/crawl-2026-11-05T12-48-11-818Z.json', 'utf8')) as BenchmarkResult;
  delete r.components;
  delete r.investigation;
  return r;
};

const typeOf = (g: ComponentGraph, signature: string) => g.types.filter((t) => t.signature === signature);
const instancesOf = (g: ComponentGraph, signature: string) => g.instances.filter((i) => typeOf(g, signature).some((t) => t.id === i.type));

describe('the component graph, on the fixture site', () => {
  const g = buildGraph(fixture())!;

  it('validates against its schema', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('gives a navigation shared by every page one type and one instance per page', () => {
    const [nav, ...more] = typeOf(g, 'component:site-nav');
    expect(more).toEqual([]);
    expect(nav).toMatchObject({ pages: g.pages.length, instances: g.pages.length, identification: 'explicit', confidence: 'high' });
    expect(new Set(instancesOf(g, 'component:site-nav').map((i) => i.page)).size).toBe(g.pages.length);
  });

  it('finds the component unique to one page', () => {
    expect(typeOf(g, 'component:live-chart')).toEqual([expect.objectContaining({ pages: 1, instances: 1 })]);
    expect(g.pages.find((p) => p.instances.includes(instancesOf(g, 'component:live-chart')[0]!.id))!.url).toMatch(/\/articles\/d$/);
  });

  it('links nested components and counts each element once', () => {
    const card = instancesOf(g, 'component:card')[0]!;
    const list = g.instances.find((i) => i.id === card.parent)!;
    expect(g.types.find((t) => t.id === list.type)!.signature).toBe('component:card-list');
    expect(list.children).toContain(card.id);
    // The list owns its own markup; the cards' elements are the cards'.
    expect(list.own.nodes).toBeLessThan(list.inclusiveNodes);
    expect(list.ownEstimated).toBe(false);
    // Owned counts on a page add up to the page's body, with the remainder unowned.
    for (const step of fixture().scenarios) {
      const s = step.anatomy!.structure!;
      const owned = s.components.reduce((t, c) => t + (c.ownNodes ?? 0), 0) + (s.unowned?.nodes ?? 0);
      expect(owned).toBeGreaterThan(0);
      expect(s.components.every((c) => (c.ownNodes ?? 0) <= c.nodes)).toBe(true);
    }
  });

  it('places resources by reach and by what loads them', () => {
    const r = (key: string) => g.resources.find((x) => x.key === key)!;
    expect(r('www.site.test/css/site.css')).toMatchObject({ scope: 'site-wide', pages: g.pages.length, loadedBy: [] });
    expect(r('www.site.test/js/cards.js').loadedBy.every((id) => instancesOf(g, 'component:card-list').some((i) => i.id === id))).toBe(true);
    expect(r('thirdparty.test/widget')).toMatchObject({ thirdParty: true, scope: 'page-unique' });
    expect(r('thirdparty.test/widget').loadedBy).toEqual(instancesOf(g, 'component:widget-embed').map((i) => i.id));
    expect(r('www.site.test/img/huge.svg').loadedBy).toEqual(instancesOf(g, 'component:hero').map((i) => i.id));
  });

  it('records what the page shows directly, on what an instance owns', () => {
    const kinds = g.findings.map((f) => f.kind);
    expect(kinds.filter((k) => k === 'endless-animation')).toHaveLength(2); // the hero pulse and the spinner
    expect(kinds).toContain('iframe');
    expect(g.findings.filter((f) => f.kind === 'large-own-dom').map((f) => instancesOf(g, 'component:long-list').some((i) => i.id === f.target.id) || f.target.type)).toContain(true);
    for (const f of g.findings) expect(f.energy).toEqual({ status: 'not-measured', measuredWorkloadDeltaMwh: null });
  });

  it('gives the same ids whatever order the pages come in, and in a re-scan', () => {
    const shuffled = fixture();
    shuffled.scenarios = [...shuffled.scenarios].reverse();
    const again = buildGraph(shuffled)!;
    const ids = (x: ComponentGraph) => ({ types: x.types.map((t) => t.id).sort(), instances: x.instances.map((i) => i.id).sort(), resources: x.resources.map((r) => r.id).sort() });
    expect(ids(again)).toEqual(ids(g));
  });

  it('keeps apart two components that share a name but not an element', () => {
    const r = fixture();
    const step = r.scenarios[0]!;
    const inst = step.anatomy!.structure!.instances!;
    const nav = inst.find((i) => i.signature === 'component:site-nav')!;
    inst.push({ ...nav, tag: 'div', role: undefined, nodePath: `${nav.nodePath},9,DIV` });
    const types = typeOf(buildGraph(r)!, 'component:site-nav');
    expect(types).toHaveLength(2);
    expect(new Set(types.map((t) => t.tag))).toEqual(new Set(['nav', 'div']));
  });
});

describe('the component graph, on the Energy.gov scan (issue #37, schema version 1)', () => {
  const { result, from, added } = migrateResult(energyGov());
  const g = result.graph!;

  it('migrates: adds the graph, keeps the measurements, and says so', () => {
    expect(from).toBe(1);
    expect(added).toContain('graph');
    expect(result).toMatchObject({ schemaVersion: 2, migratedFrom: 1 });
    expect(result.scenarios).toEqual(energyGov().scenarios);
    expect(validateGraph(g)).toEqual([]);
    expect(g.limitations.join(' ')).toMatch(/owned figures are estimated/);
  });

  it('sees the page wrapper and the header as containers, and credits the mega menu with its elements', () => {
    const wrapper = typeOf(g, 'class:dialog-off-canvas-main-canvas')[0]!;
    const header = typeOf(g, 'class:usa-header')[0]!;
    const megamenu = typeOf(g, 'class:usa-megamenu')[0]!;
    expect(wrapper).toMatchObject({ container: true, pages: 47 });
    expect(header.container).toBe(true);
    expect(megamenu.ownNodes!.median).toBeGreaterThan(header.ownNodes!.median);
    // The wrapper no longer takes its descendants' iframe and images.
    const onWrapper = g.findings.filter((f) => instancesOf(g, wrapper.signature).some((i) => i.id === f.target.id));
    expect(onWrapper.some((f) => f.kind === 'iframe' || f.kind === 'eager-offscreen-images')).toBe(false);
  });

  it('finds the icon library every page loads, and the home page’s own images', () => {
    const fa = g.resources.filter((r) => r.key.includes('/js/fontawesome/'));
    expect(fa.length).toBeGreaterThanOrEqual(5);
    expect(fa.every((r) => r.scope === 'site-wide' && r.pages === 47 && r.loadedBy.length === 0)).toBe(true);
    expect(fa.reduce((t, r) => t + r.transferBytes.median, 0)).toBeGreaterThan(3_000_000);
    const home = g.pages.find((p) => p.url === 'https://www.energy.gov/')!;
    const unique = g.resources.filter((r) => r.scope === 'page-unique' && home.resources.includes(r.id));
    expect(unique.reduce((t, r) => t + r.transferBytes.max, 0)).toBeGreaterThan(30_000_000);
  });

  it('puts the icon library first in the queue, with a remedy tied to what was recorded', () => {
    result.components = buildInventory(result.scenarios, { families: result.families!, lighthouse: result.lighthouse!, graph: g });
    const q = buildInvestigation(result)!;
    const first = q.items[0]!;
    expect(first).toMatchObject({ kind: 'resource', reach: { pages: 47, of: 47 } });
    expect(first.title).toMatch(/fontawesome/);
    expect(first.remediation[0]!.id).toBe('icon-library');
    expect(first.because[0]).toMatch(/no component loads it/);
    expect(first.urls!.every((u) => u.startsWith('https://www.energy.gov/'))).toBe(true);
    // The wrapper is queued only for findings on it directly, never for its contents.
    const wrapper = q.items.find((i) => i.title === 'class:dialog-off-canvas-main-canvas');
    if (wrapper) expect(wrapper.because.some((b) => /iframe|eager image/.test(b))).toBe(false);
  });

  it('ties Lighthouse script findings to resources, and says why the rest are not tied', () => {
    const scripts = g.findings.filter((f) => f.kind === 'lighthouse:bootup-time');
    expect(scripts.some((f) => f.target.type === 'resource')).toBe(true);
    for (const f of scripts.filter((x) => x.target.type === 'unattributed' || x.target.type === 'page')) expect(f.target.reason).toBeTruthy();
  });

  it('weighs a fraction of the result it is built from', () => {
    expect(JSON.stringify(g).length).toBeLessThan(JSON.stringify(energyGov()).length / 2);
  });
});

describe('graph schema', () => {
  const g = buildGraph(fixture())!;

  it('refuses a zero for unmeasured energy, unresolved references and unexplained unattribution', () => {
    const bad = structuredClone(g);
    bad.findings[0]!.energy.measuredWorkloadDeltaMwh = 0;
    expect(validateGraph(bad).join(' ')).toMatch(/null, never a number/);
    const dangling = structuredClone(g);
    dangling.instances[0]!.parent = 'ci-deadbeef';
    expect(validateGraph(dangling).join(' ')).toMatch(/unresolved reference ci-deadbeef/);
    const silent = structuredClone(g);
    silent.findings[0]!.target = { type: 'unattributed' };
    expect(validateGraph(silent).join(' ')).toMatch(/says why/);
  });

  it('is published as JSON Schema, in step with the code', () => {
    expect(JSON.parse(readFileSync('schema/component-graph.schema.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(graphJsonSchema())));
  });
});

describe('migration', () => {
  it('leaves a current result alone', () => {
    const r = fixture();
    r.schemaVersion = 2;
    r.graph = buildGraph(r)!;
    const m = migrateResult(r);
    expect(m.added).toEqual([]);
    expect(m.result.graph).toBe(r.graph);
    expect(m.result.migratedFrom).toBeUndefined();
  });
});

describe('resource identity', () => {
  it('keeps what names an asset and drops what varies per page or per hit', () => {
    expect(resourceIdentity('https://a.org/app.js?v=3')).toBe('a.org/app.js?v=3');
    expect(resourceIdentity('https://q.example.com/e.js?Q_ZID=1&Q_LOC=https%3A%2F%2Fa.org%2Fpage')).toBe('q.example.com/e.js?Q_ZID=1');
    expect(resourceIdentity('https://a.org/x.js?cb=1730000000000')).toBe('a.org/x.js');
    expect(resourceIdentity('https://www.googletagmanager.com/a?v=3&t=l&pid=1', 'image', true)).toBe('www.googletagmanager.com/a');
    expect(resourceIdentity('https://www.googletagmanager.com/gtag/js?id=G-1', 'script', true)).toBe('www.googletagmanager.com/gtag/js?id=G-1');
    expect(resourceIdentity(`https://a.org/p?${'x'.repeat(400)}=1`).length).toBeLessThan(260);
  });
});

describe('inferred kinds', () => {
  it('labels kinds from names and contents, and never a dialog from a class name alone', () => {
    const none = { nodes: 1, images: 0, eagerOffscreenImages: 0, videos: 0, autoplayVideos: 0, iframes: 0, canvases: 0, animations: 0, infiniteAnimations: 0 };
    expect(inferKind('class:hero-carousel', 'div', undefined, none)!.kind).toBe('carousel');
    expect(inferKind('class:dialog-off-canvas-main-canvas', 'div', undefined, none)).toBeUndefined();
    expect(inferKind('class:x', 'div', 'dialog', none)!.kind).toBe('modal dialog');
    expect(inferKind('class:x', 'div', undefined, { ...none, videos: 1 })!.kind).toBe('media player');
  });
});

describe('resources in the reports', () => {
  const g = buildGraph(fixture())!;

  it('lists resources by reach in accessible tables, without scripts', () => {
    const html = resourcesSection(g);
    expect(html).toContain('<h2 id="resources-h">Resources</h2>');
    expect(html).toContain('<caption>Loaded on nearly every page, heaviest first</caption>');
    expect(html).toContain('page-level: no recorded component’s element loads it');
    expect(html).not.toMatch(/<script|<canvas/i);
  });

  it('writes one CSV row per resource', () => {
    const lines = resourcesCsv(g).trim().split('\n');
    expect(lines[0]).toBe('resource_id,key,host,kind,third_party,scope,pages,families,transfer_bytes_median,transfer_bytes_max,loaded_by_instances');
    expect(lines).toHaveLength(g.resources.length + 1);
  });
});
