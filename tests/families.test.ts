import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFamilies, similarity } from '../src/analysis/families.js';
import { pageFeatures, pageFingerprint, resourceKey } from '../src/analysis/signature.js';
import { isIdSegment, urlPattern, urlSection } from '../src/analysis/url-pattern.js';
import { familiesSection } from '../src/report/families-html.js';
import { toCsv } from '../src/report/csv.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';
import type { ComponentSignature, PageStructure } from '../src/collect/page-anatomy.js';

const comp = (signature: string, nodes = 50, method: ComponentSignature['method'] = 'drupal'): ComponentSignature => ({
  signature,
  method,
  count: 1,
  nodes,
});

/** The site's shared chrome: on every page, so it cannot tell pages apart on its own. */
const CHROME = [comp('drupal-region:header', 300), comp('drupal-region:footer', 120), comp('drupal-block:system-menu-block-main', 200)];
const SHARED_JS = ['/core/misc/drupal.js', '/sites/default/files/js/js_global.js'];

function step(url: string, o: { components?: ComponentSignature[]; scripts?: string[]; template?: string; domNodes?: number; bytes?: number; structure?: boolean; subtrees?: string[] } = {}): StepResult {
  const structure: PageStructure | undefined =
    o.structure === false
      ? undefined
      : {
          landmarks: ['banner', 'navigation', 'main', 'contentinfo'],
          components: [...CHROME, ...(o.components ?? [])],
          frameworks: ['drupal'],
          drupal: { bodyClasses: [], ...(o.template ? { pageTemplate: o.template } : {}) },
        };
  const scripts = [...SHARED_JS, ...(o.scripts ?? [])];
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
      requests: scripts.length + 3,
      transferBytes: o.bytes ?? 400_000,
      thirdPartyRequests: 1,
      thirdPartyBytes: 1000,
      byType: {},
      resources: [
        ...scripts.map((p) => ({ url: `https://site.org${p}?v=123`, domain: 'site.org', thirdParty: false, resourceType: 'script', transferBytes: 1000 })),
        { url: 'https://cdn.analytics.net/a.js?page=' + encodeURIComponent(url), domain: 'cdn.analytics.net', thirdParty: true, resourceType: 'script', transferBytes: 1000 },
      ],
    },
    anatomy: {
      domNodes: o.domNodes ?? 1500,
      domDepth: 20,
      cssRules: 100,
      cssSelectors: 120,
      scripts: scripts.length,
      images: 3,
      iframes: 0,
      animatedElements: 0,
      heaviestSubtrees: (o.subtrees ?? ['header#header']).map((selector) => ({ selector, nodes: 500 })),
      ...(structure ? { structure } : {}),
    },
    valid: true,
    warnings: [],
  };
}

const article = (i: number, extra: Parameters<typeof step>[1] = {}) =>
  step(`https://site.org/news/2024/story-${i}`, {
    components: [comp('drupal-node:article:full', 400), comp('drupal-paragraph:text', 60), comp('drupal-block:related-content', 80)],
    scripts: ['/modules/contrib/social_share/share.js'],
    template: 'page-node-type-article',
    ...extra,
  });
const listing = (i: number) =>
  step(`https://site.org/events/page-${i}`, {
    components: [comp('drupal-view:events', 900), comp('drupal-node:event:teaser', 600), comp('drupal-block:facets', 150)],
    scripts: ['/modules/contrib/facets/facets.js', '/libraries/calendar/calendar.js'],
    template: 'page-view-events',
  });

describe('urlPattern and urlSection', () => {
  it('replaces items with :id and keeps sections', () => {
    expect(urlPattern('https://a.org/news/2024/05/budget-update')).toBe('/news/:id/:id/:id');
    expect(urlPattern('https://a.org/en/page-1.html')).toBe('/en/:id.html');
    expect(urlPattern('https://www.cms.gov/medicare/x-items/cms1242525')).toBe('/medicare/x-items/:id');
    expect(urlPattern('https://a.org/about')).toBe('/about');
    expect(urlPattern('https://a.org/')).toBe('/');
    expect(urlSection('https://www.cms.gov/regulations-and-guidance/guidance/transmittals/transmittals/r11787fm')).toBe(
      '/regulations-and-guidance/guidance',
    );
    expect(urlSection('https://a.org/about')).toBe('/');
    expect(urlSection('https://a.org/news/2024/story')).toBe('/news');
  });

  it('tells items from words', () => {
    for (const s of ['123', 'cms1242525', 'r11787fm', '2024-05-01', '5f2b8c1e9a7d']) expect(isIdSegment(s)).toBe(true);
    for (const s of ['news', 'policy-and-memos', 'about-us', 'v2']) expect(isIdSegment(s)).toBe(false);
  });

  it('keys resources by host and path', () => {
    expect(resourceKey('https://A.org/x.js?v=1&page=%2F')).toBe('a.org/x.js');
  });
});

describe('buildFamilies', () => {
  const steps = [...[1, 2, 3, 4, 5].map((i) => article(i)), ...[1, 2, 3].map(listing), step('https://site.org/', { components: [comp('drupal-block:hero', 300), comp('class:carousel', 200, 'class-heuristic')], template: 'path-frontpage' })];

  it('groups pages built alike and keeps different templates apart', () => {
    const r = buildFamilies(steps)!;
    expect(r.families.map((f) => f.pages.length)).toEqual([5, 3, 1]);
    expect(r.families[0]!.pages.every((u) => u.includes('/news/'))).toBe(true);
    expect(r.families[1]!.pages.every((u) => u.includes('/events/'))).toBe(true);
    expect(r.families[0]!.signals).toContain('t:page-node-type-article');
    expect(r.families[0]!.label).toContain('page-node-type-article');
    expect(r.pagesGrouped).toBe(9);
  });

  it('gives the same families and ids whatever order the pages arrive in', () => {
    const a = buildFamilies(steps)!;
    const b = buildFamilies([...steps].reverse())!;
    const c = buildFamilies([steps[3]!, steps[7]!, steps[0]!, steps[8]!, steps[5]!, steps[1]!, steps[6]!, steps[2]!, steps[4]!])!;
    expect(b.families).toEqual(a.families);
    expect(c.families).toEqual(a.families);
  });

  it('keeps a family id when the family gains a page, and a fingerprint across deploys', () => {
    const before = buildFamilies(steps)!;
    const after = buildFamilies([...steps, article(6)])!;
    expect(after.families[0]!.id).toBe(before.families[0]!.id);
    // A deploy renames the aggregated assets; the page's fingerprint ignores resources.
    const deployed = article(1, { scripts: ['/sites/default/files/js/js_NEWHASH.js'] });
    expect(pageFingerprint(pageFeatures(deployed)!)).toBe(pageFingerprint(pageFeatures(article(1))!));
  });

  it('names a representative and the pages far from the family median', () => {
    const r = buildFamilies([...steps, article(6, { domNodes: 6000 })])!;
    const news = r.families.find((f) => f.pages.some((u) => u.includes('/news/')))!;
    expect(news.pages).toContain(news.representative);
    expect(news.outliers).toEqual([expect.objectContaining({ url: 'https://site.org/news/2024/story-6', metric: 'domNodes', ratio: 4 })]);
    expect(news.metrics.domNodes!.median).toBe(1500);
  });

  it('collapses exact duplicates into one family with cohesion 1', () => {
    const r = buildFamilies([article(1), article(2), article(3)])!;
    expect(r.families).toHaveLength(1);
    expect(r.families[0]!.cohesion).toBe(1);
  });

  it('keeps ids unique when two families share every structural signal', () => {
    // Same structure, entirely different scripts: two families, one set of signals.
    const a = [1, 2].map((i) => step(`https://site.org/a/p${i}`, { scripts: ['/a1.js', '/a2.js', '/a3.js', '/a4.js'] }));
    const b = [1, 2].map((i) => step(`https://site.org/b/p${i}`, { scripts: ['/b1.js', '/b2.js', '/b3.js', '/b4.js'] }));
    const r = buildFamilies([...a, ...b], { threshold: 0.95 })!;
    const ids = r.families.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('needs two pages with structure, and skips warm-ups and failures', () => {
    expect(buildFamilies([article(1)])).toBeUndefined();
    expect(buildFamilies([article(1), { ...article(2), warmup: true }, { ...article(3), valid: false }])).toBeUndefined();
  });

  it('says what it does not cover, and never extrapolates', () => {
    const r = buildFamilies(steps, { listed: 4202 })!;
    expect(r.limitations[0]).toMatch(/9 pages measured in this scan out of 4202/);
    expect(r.limitations[0]).toMatch(/not extrapolated/);
  });

  it('groups results made before page structure was recorded, and says so', () => {
    const old = [1, 2, 3].map((i) => article(i, { structure: false, subtrees: ['header#header', 'article.node-:id'] }));
    old.push(step('https://site.org/', { structure: false, subtrees: ['div.hero'], scripts: ['/front.js', '/slider.js'] }));
    const r = buildFamilies(old)!;
    expect(r.families.map((f) => f.pages.length)).toEqual([3, 1]);
    expect(r.limitations.at(-1)).toMatch(/4 of 4 pages were scanned before page structure was recorded/);
  });

  it('rates identical pages 1 and unrelated pages low', () => {
    const a = pageFeatures(article(1))!;
    expect(similarity(a, pageFeatures(article(2))!)).toBeGreaterThan(0.9);
    expect(similarity(a, pageFeatures(listing(1))!)).toBeLessThan(0.6);
  });

  it('separates the cms.gov home page from its template pages (issue #31 result)', () => {
    const result = JSON.parse(readFileSync('site/results/crawl-2026-11-04T18-47-05-533Z.json', 'utf8')) as BenchmarkResult;
    const r = buildFamilies(result.scenarios)!;
    expect(r.families.map((f) => f.pages.length)).toEqual([19, 1]);
    expect(r.families[1]!.pages).toEqual(['https://www.cms.gov/']);
  });
});

describe('families in the reports', () => {
  const steps = [...[1, 2, 3].map((i) => article(i)), ...[1, 2].map(listing)];
  const families = buildFamilies(steps)!;

  it('renders a table with headers, one disclosure per family, and no scripts', () => {
    const html = familiesSection(families, {
      method: 'adaptive',
      source: 'https://site.org/sitemap.xml',
      listed: 40,
      picked: 6,
      reasons: { 'https://site.org/': 'start', 'https://site.org/news/2024/story-1': 'representative' },
      strata: [{ section: '/news', listed: 30, picked: 3, rare: false }],
      strataTotal: 1,
      limitations: ['Sections come from URL paths.'],
    });
    expect(html).toContain('<h2 id="families-h">Page families</h2>');
    expect(html).toContain('<caption>Page families, largest first');
    expect(html.match(/<th scope="col">/g)!.length).toBeGreaterThanOrEqual(8);
    expect(html.match(/<details id="pf-/g)).toHaveLength(families.families.length);
    expect(html).toContain('1 start page, 1 one per URL section');
    expect(html).not.toMatch(/<script|<canvas|onclick/i);
  });

  it('never makes a link of a URL that is not http(s), and escapes everything', () => {
    const odd = buildFamilies([{ ...article(1), url: 'javascript:alert(1)' }, article(2), { ...article(3), url: 'https://site.org/<b>' }])!;
    const html = familiesSection(odd, undefined);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<b>');
  });

  it('adds family, fingerprint, pattern and reason columns at the end of the CSV', () => {
    const result = {
      session: { id: 's', startedAt: '', mode: 'crawl' },
      environment: { timestamp: '', os: '', osVersion: '', architecture: '', cpuCount: 1, totalMemoryBytes: 1, energyAdapter: 'noop', headed: false, viewport: { width: 1, height: 1 } },
      configuration: {},
      scenarios: steps,
      families,
      sampling: { method: 'sitemap', picked: 5, reasons: { [steps[0]!.step]: 'start' } },
      warnings: [],
    } as unknown as BenchmarkResult;
    const [head, first] = toCsv(result).split('\n');
    expect(head!.endsWith(',valid,family_id,page_fingerprint,url_pattern,sample_reason')).toBe(true);
    const cells = first!.split(',');
    expect(cells.at(-4)).toBe(families.pageFamily[steps[0]!.url!]);
    expect(cells.at(-3)).toMatch(/^fp-[0-9a-f]{8}$/);
    expect(cells.at(-2)).toBe('/news/:id/:id');
    expect(cells.at(-1)).toBe('start');
  });
});
