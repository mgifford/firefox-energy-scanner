import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildInventory, matchNode } from '../src/analysis/components.js';
import { buildFamilies } from '../src/analysis/families.js';
import { extractEvidence } from '../src/lighthouse/evidence.js';
import { combineRuns, summarizeLhr, type Lhr, type LighthouseSummary } from '../src/lighthouse/summary.js';
import { summarizeRegions, templatesForInstances } from '../src/drupal/twig-debug.js';
import { componentsCsv } from '../src/report/components-csv.js';
import { componentsSection } from '../src/report/components-html.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';
import type { ComponentInstance, ComponentSignature } from '../src/collect/page-anatomy.js';

const ORIGIN = 'http://127.0.0.1:8099';
const lhr = () => JSON.parse(readFileSync('tests/fixtures/lhr13-evidence.json', 'utf8')) as Lhr;

const inst = (signature: string, nodePath: string, extra: Partial<ComponentInstance> = {}): ComponentInstance => ({
  signature,
  method: signature.startsWith('landmark:') ? 'landmark' : signature.startsWith('component:') ? 'annotation' : 'drupal',
  selector: signature,
  nodePath,
  ancestry: [],
  nodes: 10,
  depth: 2,
  rect: { x: 0, y: 0, width: 100, height: 100 },
  belowFold: false,
  ...extra,
});

/** The fixture page's structure, as Firefox records it (paths as in the Lighthouse fixture). */
const INSTANCES = [
  inst('landmark:main', '1,HTML,1,BODY,1,MAIN', { nodes: 308 }),
  inst('drupal-view:frontpage', '1,HTML,1,BODY,1,MAIN,2,SECTION', { nodes: 301, media: { images: 60, eagerOffscreenImages: 59, videos: 0, autoplayVideos: 0, iframes: 0, canvases: 0 } }),
  inst('drupal-node:article:teaser', '1,HTML,1,BODY,1,MAIN,2,SECTION,0,ARTICLE', { nodes: 5 }),
  inst('component:theme:carousel', '1,HTML,1,BODY,1,MAIN,0,DIV', {
    nodes: 3,
    animations: { running: 1, infinite: 1, names: ['pulse'] },
    resources: [{ url: `${ORIGIN}/img/hero.svg`, kind: 'image' }],
  }),
  inst('landmark:navigation', '1,HTML,1,BODY,0,HEADER,0,NAV', { nodes: 62 }),
  inst('component:theme:video', '1,HTML,1,BODY,1,MAIN,3,DIV', {
    media: { images: 0, eagerOffscreenImages: 0, videos: 1, autoplayVideos: 1, iframes: 1, canvases: 0 },
    resources: [
      { url: 'https://player.example.net/embed/1', kind: 'iframe' },
      { url: `${ORIGIN}/js/app.js`, kind: 'script' },
    ],
  }),
];

const components: ComponentSignature[] = [
  { signature: 'landmark:main', method: 'landmark', count: 1, nodes: 308 },
  { signature: 'drupal-view:frontpage', method: 'drupal', count: 1, nodes: 301 },
  { signature: 'drupal-node:article:teaser', method: 'drupal', count: 60, nodes: 300 },
  { signature: 'component:theme:carousel', method: 'annotation', count: 1, nodes: 3 },
  { signature: 'landmark:navigation', method: 'landmark', count: 1, nodes: 62 },
  { signature: 'component:theme:video', method: 'annotation', count: 1, nodes: 4 },
  { signature: 'class:promo', method: 'class-heuristic', count: 1, nodes: 12 },
];

function page(url: string, o: { instances?: ComponentInstance[]; withInstances?: boolean } = {}): StepResult {
  return {
    scenario: 'crawl',
    step: url,
    run: 0,
    warmup: false,
    url,
    startedAt: 0,
    endedAt: 1,
    timing: { durationMs: 1 },
    network: {
      requests: 2,
      transferBytes: 10_000,
      thirdPartyRequests: 1,
      thirdPartyBytes: 5000,
      byType: {},
      resources: [
        { url: `${ORIGIN}/img/hero.svg?v=1`, domain: '127.0.0.1', thirdParty: false, resourceType: 'image', transferBytes: 2048 },
        { url: 'https://player.example.net/embed/1', domain: 'player.example.net', thirdParty: true, resourceType: 'document', transferBytes: 50_000 },
      ],
    },
    anatomy: {
      domNodes: 380,
      domDepth: 8,
      cssRules: 0,
      cssSelectors: 0,
      scripts: 1,
      images: 61,
      iframes: 1,
      animatedElements: 2,
      structure: {
        landmarks: ['banner', 'navigation', 'main', 'contentinfo'],
        components,
        frameworks: ['drupal'],
        ...(o.withInstances === false ? {} : { instances: o.instances ?? INSTANCES }),
      },
    },
    valid: true,
    warnings: [],
  };
}

const lighthouseFor = (url: string): LighthouseSummary => ({
  tool: 'lighthouse',
  version: '13.5.0',
  formFactor: 'mobile',
  throttling: 'simulated',
  categories: ['performance'],
  runsPerUrl: 1,
  results: [combineRuns(url, [summarizeLhr(lhr(), url)])],
});

describe('extractEvidence (Lighthouse 13)', () => {
  it('reads the elements and scripts Lighthouse names, with their node paths', () => {
    const e = extractEvidence(lhr());
    expect(e.nodes.map((n) => [n.audit, n.path])).toEqual(
      expect.arrayContaining([
        ['non-composited-animations', '1,HTML,1,BODY,1,MAIN,0,DIV,0,DIV'],
        ['unsized-images', '1,HTML,1,BODY,1,MAIN,0,DIV,1,IMG'],
        ['lcp-breakdown-insight', '1,HTML,1,BODY,1,MAIN,2,SECTION,0,ARTICLE,0,H2'],
        ['dom-size-insight', '1,HTML,1,BODY,1,MAIN,2,SECTION'],
      ]),
    );
    const composited = e.nodes.find((n) => n.audit === 'non-composited-animations')!;
    expect(composited.detail).toMatch(/Unsupported CSS Property: width/);
    expect(e.nodes.find((n) => n.detail === 'Most children')).toMatchObject({ value: 60, unit: 'count' });
    expect(e.scripts.find((s) => s.audit === 'bootup-time' && s.url.endsWith('/js/app.js'))).toMatchObject({ unit: 'ms' });
    expect(e.scripts.some((s) => s.url === 'Unattributable')).toBe(true);
  });

  it('is kept with the median run and survives an audit it does not know', () => {
    const broken = lhr();
    (broken.audits['dom-size-insight'] as { details: unknown }).details = { type: 'table', items: [{ node: 'not a node' }] };
    const r = summarizeLhr(broken, `${ORIGIN}/`);
    expect(r.evidence!.nodes.length).toBeGreaterThan(0);
    expect(combineRuns(`${ORIGIN}/`, [r]).evidence).toEqual(r.evidence);
  });
});

describe('matchNode', () => {
  it('takes the deepest occurrence containing the element', () => {
    expect(matchNode(INSTANCES, '1,HTML,1,BODY,1,MAIN,0,DIV,1,IMG')).toMatchObject({ instance: { signature: 'component:theme:carousel' }, matchedBy: 'node-path' });
    expect(matchNode(INSTANCES, '1,HTML,1,BODY,1,MAIN')!.instance.signature).toBe('landmark:main');
    // A path segment boundary: MAIN,0,DIV must not claim MAIN,0,DIVX… or MAIN,10,DIV.
    expect(matchNode(INSTANCES, '1,HTML,1,BODY,1,MAIN,10,DIV')!.instance.signature).toBe('landmark:main');
  });

  it('falls back to element names only when exactly one occurrence fits', () => {
    // A cookie banner shifted every index in Chromium: positions differ, names do not.
    const shifted = '1,HTML,1,BODY,0,HEADER,0,NAV,0,UL'.replace('0,HEADER', '1,HEADER');
    expect(matchNode(INSTANCES.filter((i) => i.signature !== 'landmark:main'), shifted)).toMatchObject({ matchedBy: 'tag-path', instance: { signature: 'landmark:navigation' } });
    const twins = [inst('drupal-block:a', '1,HTML,1,BODY,0,DIV'), inst('drupal-block:b', '1,HTML,1,BODY,1,DIV')];
    expect(matchNode(twins, '1,HTML,1,BODY,5,DIV,0,P')).toBeUndefined();
    expect(matchNode(INSTANCES, '1,HTML,0,HEAD,3,SCRIPT')).toBeUndefined();
  });
});

describe('buildInventory', () => {
  const urls = [`${ORIGIN}/`, `${ORIGIN}/?page=2`, `${ORIGIN}/news`];
  const steps = urls.map((u) => page(u));
  const inv = () => buildInventory(steps, { families: buildFamilies(steps)!, lighthouse: lighthouseFor(urls[0]!) })!;
  const rec = (sig: string) => inv().components.find((c) => c.signature === sig)!;

  it('finds recurring components with stable ids, reach and families', () => {
    const c = rec('component:theme:carousel');
    expect(c.id).toMatch(/^cmp-[0-9a-f]{8}$/);
    expect(c.id).toBe(buildInventory([page(urls[2]!)])!.components.find((x) => x.signature === 'component:theme:carousel')!.id);
    expect(c).toMatchObject({ pages: 3, reach: 1, occurrences: 3, kind: 'component', confidence: 'high' });
    expect(c.families).toHaveLength(1);
    expect(rec('class:promo').confidence).toBe('low');
    expect(rec('landmark:main').kind).toBe('region');
    // Components before regions.
    expect(inv().components.findIndex((x) => x.kind === 'region')).toBeGreaterThan(inv().components.findIndex((x) => x.kind === 'component'));
  });

  it('ties Lighthouse element findings to the component they fall in, on the page they came from', () => {
    const c = rec('component:theme:carousel');
    expect(c.evidence.map((e) => [e.audit, e.matchedBy, e.page])).toEqual([
      ['non-composited-animations', 'node-path', urls[0]],
      ['unsized-images', 'node-path', urls[0]],
    ]);
    expect(c.evidence.every((e) => e.boundary === 'chromium-lab')).toBe(true);
    // ?page=2 is another page: the home page's evidence is not copied to it.
    expect(new Set(inv().components.flatMap((x) => x.evidence.map((e) => e.page)))).toEqual(new Set([urls[0]]));
    expect(rec('drupal-node:article:teaser').evidence[0]).toMatchObject({ audit: 'lcp-breakdown-insight' });
  });

  it('ties scripts only to the component that loads them, and says why the rest are unattributed', () => {
    expect(rec('component:theme:video').evidence.filter((e) => e.matchedBy === 'script-in-component').map((e) => e.audit).sort()).toEqual(['bootup-time', 'long-tasks']);
    const reasons = inv().unattributed.map((u) => u.reason);
    expect(reasons.some((r) => /could not name the script/.test(r))).toBe(true);
    expect(reasons.some((r) => /own inline scripts/.test(r))).toBe(true);
  });

  it('states facts as signals, with transfer for the resources it loads', () => {
    const c = rec('component:theme:carousel');
    expect(c.signals.join(' ')).toMatch(/1 animation that never stops \(pulse\)/);
    expect(c.resources[0]).toMatchObject({ kind: 'image', transferBytes: 2048, thirdParty: false });
    const video = rec('component:theme:video');
    expect(video.signals.join(' ')).toMatch(/1 video playing on load.*1 iframe \(player\.example\.net\)/);
    expect(rec('drupal-node:article:teaser').signals.join(' ')).toMatch(/Its 60 occurrences on a page hold 79%/);
  });

  it('never reports an energy figure for a component', () => {
    const json = JSON.stringify(inv().components.map(({ limitations: _l, ...c }) => c));
    expect(json).not.toMatch(/joule|mwh|watt|energy/i);
    expect(inv().limitations[0]).toMatch(/No figure here is a component’s energy/);
  });

  it('says when Lighthouse did not run, and returns nothing for results without occurrences', () => {
    expect(buildInventory(steps)!.limitations.at(-1)).toMatch(/Lighthouse did not run/);
    expect(buildInventory(steps)!.lighthousePages).toBe(0);
    expect(buildInventory([page(urls[0]!, { withInstances: false })])).toBeUndefined();
  });

  it('is the same whatever order the pages come in', () => {
    const a = buildInventory(steps, { lighthouse: lighthouseFor(urls[0]!) })!;
    const b = buildInventory([...steps].reverse(), { lighthouse: lighthouseFor(urls[0]!) })!;
    expect(b.components).toEqual(a.components);
  });
});

describe('Twig templates for components', () => {
  it('names the innermost template whose output starts at the component', () => {
    const report = summarizeRegions([
      { template: 'themes/x/region.html.twig', start: 0, end: 50, rootPath: '1,HTML,1,BODY,1,MAIN' },
      { template: 'themes/x/views-view.html.twig', start: 10, end: 40, rootPath: '1,HTML,1,BODY,1,MAIN,2,SECTION' },
      // No wrapper of its own: starts at the same element as the view.
      { template: 'themes/x/views-view-unformatted.html.twig', start: 10, end: 38, rootPath: '1,HTML,1,BODY,1,MAIN,2,SECTION' },
    ]);
    expect(report.templates.find((t) => t.name === 'region.html.twig')!.rootPaths).toEqual(['1,HTML,1,BODY,1,MAIN']);
    const found = templatesForInstances(INSTANCES, report);
    expect(found.find((t) => t.signature === 'drupal-view:frontpage')!.name).toBe('views-view-unformatted.html.twig');
    expect(found.find((t) => t.signature === 'landmark:main')!.name).toBe('region.html.twig');
    expect(found.some((t) => t.signature === 'component:theme:carousel')).toBe(false);
  });
});

describe('components in the reports', () => {
  const steps = [page(`${ORIGIN}/`), page(`${ORIGIN}/news`)];
  const result = {
    session: { id: 's', startedAt: '', mode: 'crawl' },
    scenarios: steps,
    components: buildInventory(steps, { lighthouse: lighthouseFor(`${ORIGIN}/`) }),
  } as unknown as BenchmarkResult;

  it('writes one CSV row per component and neutralises spreadsheet formulas', () => {
    const odd = structuredClone(result);
    odd.components!.components[0]!.signature = '=HYPERLINK("x")';
    const lines = componentsCsv(odd).trim().split('\n');
    expect(lines[0]!.startsWith('component_id,signature,kind,method,confidence,pages')).toBe(true);
    expect(lines).toHaveLength(1 + odd.components!.components.length);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('renders accessible tables and disclosures, says it is not energy, and has no scripts', () => {
    const html = componentsSection(result.components);
    expect(html).toContain('<h2 id="components-h">Components</h2>');
    expect(html).toContain('None of these figures is a component’s energy.');
    expect(html).toMatch(/<caption>Lighthouse findings tied to it \(Chromium lab, not Firefox energy\)<\/caption>/);
    expect(html.match(/<th scope="col">/g)!.length).toBeGreaterThanOrEqual(6);
    expect(html).not.toMatch(/<script|<canvas|onclick/i);
  });
});
