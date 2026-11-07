import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInvestigation } from '../src/analysis/investigation.js';
import { remediationsFor } from '../src/analysis/remediation.js';
import { compareWithPrevious, findPrevious } from '../src/analysis/history.js';
import { investigationSection, historySection } from '../src/report/investigation-html.js';
import { queueCsv } from '../src/report/queue-csv.js';
import type { ComponentEvidence, ComponentInventory, ComponentRecord } from '../src/analysis/components.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';

function record(signature: string, o: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: `cmp-${signature.length.toString(16).padStart(8, '0')}${signature.replace(/\W/g, '').slice(0, 4)}`,
    signature,
    method: 'drupal',
    kind: 'component',
    confidence: 'high',
    pages: 3,
    reach: 1,
    families: ['pf-1'],
    occurrences: 3,
    nodes: { median: 40, max: 40 },
    shareOfPage: 0.05,
    roles: [],
    names: [],
    resources: [],
    thirdPartyHosts: [],
    evidence: [],
    examples: [{ page: 'https://a.org/', selector: `.${signature}`, nodePath: '1,HTML,1,BODY,0,DIV', rect: { x: 0, y: 1200, width: 1000, height: 300 }, belowFold: true }],
    signals: [],
    limitations: [],
    ...o,
  };
}

const finding = (audit: string, extra: Partial<ComponentEvidence> = {}): ComponentEvidence => ({
  source: 'lighthouse',
  boundary: 'chromium-lab',
  audit,
  title: audit,
  kind: 'finding',
  page: 'https://a.org/',
  matchedBy: 'node-path',
  detail: audit,
  ...extra,
});

function resultWith(components: ComponentRecord[], extra: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const inv: ComponentInventory = {
    method: 'inventory-v1',
    pages: 3,
    lighthousePages: 1,
    components,
    unattributed: [],
    limitations: [],
  };
  return {
    schemaVersion: 1,
    session: { id: 'now', startedAt: '2026-11-05T10:00:00.000Z', mode: 'crawl' },
    environment: { timestamp: '', os: 'linux', osVersion: '', architecture: 'x64', cpuCount: 1, totalMemoryBytes: 1, energyAdapter: 'noop', headed: false, viewport: { width: 1440, height: 900 } },
    target: { url: 'https://a.org/' },
    configuration: {},
    scenarios: [],
    components: inv,
    warnings: [],
    ...extra,
  } as BenchmarkResult;
}

describe('remediationsFor', () => {
  it('maps recorded facts and findings to remedies, each with a rationale and a way to check it', () => {
    const r = record('component:carousel', {
      animations: { running: 1, infinite: 1, names: ['spin'] },
      evidence: [finding('non-composited-animations')],
      media: { images: 4, eagerOffscreenImages: 3, videos: 0, autoplayVideos: 0, iframes: 1, canvases: 0 },
    });
    const ids = remediationsFor(r).map((x) => x.id);
    expect(ids).toEqual(['stop-endless-animation', 'respect-reduced-motion', 'composite-animation', 'facade-iframe', 'lazy-load-images']);
    for (const x of remediationsFor(r)) {
      expect(x.rationale.length).toBeGreaterThan(20);
      expect(x.verify).toMatch(/compare|Lighthouse|measure|experiment/i);
    }
  });

  it('ignores Lighthouse context: the LCP element and a passing DOM audit trigger nothing', () => {
    const r = record('drupal-view:x', { evidence: [finding('lcp-breakdown-insight', { kind: 'context' }), finding('dom-size-insight', { kind: 'context' })] });
    expect(remediationsFor(r)).toEqual([]);
    expect(remediationsFor(record('drupal-view:x', { evidence: [finding('dom-size-insight')] })).map((x) => x.id)).toEqual(['reduce-dom']);
  });
});

describe('buildInvestigation', () => {
  const carousel = record('component:carousel', { pages: 2, animations: { running: 1, infinite: 1, names: [] }, evidence: [finding('non-composited-animations')] });
  const menu = record('drupal-block:menu', { pages: 3, nodes: { median: 1244, max: 1244 }, shareOfPage: 0.78 });
  const lightOnly = record('drupal-block:banner', { pages: 3, evidence: [finding('layout-shifts', { value: 0.2, unit: 'score' })] });
  const quiet = record('drupal-block:footer', { pages: 3 });
  const region = record('landmark:main', { kind: 'region', method: 'landmark', confidence: 'medium', pages: 3, nodes: { median: 1500, max: 1500 }, shareOfPage: 0.9 });

  it('orders by evidence, then reach, then opportunity, then workload, and says so', () => {
    const q = buildInvestigation(resultWith([quiet, menu, lightOnly, carousel, region]))!;
    expect(q.items.map((i) => i.title)).toEqual(['component:carousel', 'drupal-block:banner', 'drupal-block:menu']);
    expect(q.items.map((i) => i.evidence)).toEqual(['structure-and-lighthouse', 'lighthouse', 'structure']);
    expect(q.items.map((i) => i.rank)).toEqual([1, 2, 3]);
    expect(q.order).toHaveLength(4);
    expect(q.limitations[0]).toMatch(/not a score/);
  });

  it('breaks ties by reach before workload, deterministically', () => {
    const big = record('drupal-block:big', { pages: 1, nodes: { median: 5000, max: 5000 }, shareOfPage: 0.9 });
    const wide = record('drupal-block:wide', { pages: 3, nodes: { median: 900, max: 900 }, shareOfPage: 0.3 });
    const a = buildInvestigation(resultWith([big, wide]))!;
    const b = buildInvestigation(resultWith([wide, big]))!;
    expect(a.items.map((i) => i.title)).toEqual(['drupal-block:wide', 'drupal-block:big']);
    expect(b.items).toEqual(a.items);
  });

  it('keeps every indicator separate and none of them is energy or a score', () => {
    const q = buildInvestigation(resultWith([carousel, menu]))!;
    const json = JSON.stringify(q.items);
    expect(json).not.toMatch(/"score"|joule|mwh|watt|"energy"/i);
    expect(q.items[1]!.workload).toEqual({ elements: 1244, shareOfPage: 0.78 });
  });

  it('queues a region only for a Lighthouse finding that landed on it', () => {
    expect(buildInvestigation(resultWith([region]))).toBeUndefined();
    const withFinding = { ...region, evidence: [finding('dom-size-insight')] };
    expect(buildInvestigation(resultWith([withFinding]))!.items[0]).toMatchObject({ kind: 'region', evidence: 'structure-and-lighthouse' });
  });

  it('adds scripts no component loads, and pages far from their family', () => {
    const r = resultWith([quiet]);
    r.components!.unattributed = [
      { page: 'https://a.org/', audit: 'bootup-time', title: 't', kind: 'finding', value: 900, unit: 'ms', target: 'https://a.org/js/all.js?v=1', reason: 'No recorded component loads this script: bundled.' },
      { page: 'https://a.org/b', audit: 'bootup-time', title: 't', kind: 'finding', value: 700, unit: 'ms', target: 'https://a.org/js/all.js?v=2', reason: 'No recorded component loads this script: bundled.' },
      { page: 'https://a.org/', audit: 'bootup-time', title: 't', kind: 'finding', value: 400, unit: 'ms', target: 'Unattributable', reason: 'Chromium could not name the script.' },
      { page: 'https://a.org/', audit: 'bootup-time', title: 't', kind: 'context', value: 80, unit: 'ms', target: 'https://a.org/js/small.js', reason: 'No recorded component loads this script.' },
    ];
    r.families = {
      method: 'structure-v1', threshold: 0.6, weights: {} as never, pagesGrouped: 3, pageFamily: {}, pagePattern: {}, limitations: [],
      pageFingerprint: { 'https://a.org/huge': 'fp-0000abcd' },
      families: [{ id: 'pf-1', label: '/news/:id', pages: [], representative: 'https://a.org/news/1', urlPatterns: [], signals: [], cohesion: 1, metrics: {},
        outliers: [{ url: 'https://a.org/huge', metric: 'domNodes', value: 6000, median: 1500, ratio: 4 }, { url: 'https://a.org/tiny', metric: 'domNodes', value: 100, median: 1500, ratio: 0.07 }] }],
    };
    const q = buildInvestigation(r)!;
    const script = q.items.find((i) => i.kind === 'script')!;
    expect(script).toMatchObject({ reach: { pages: 2 }, workload: { chromiumMainThreadMs: 900 } });
    expect(q.items.filter((i) => i.kind === 'script')).toHaveLength(1);
    const page = q.items.find((i) => i.kind === 'page')!;
    expect(page).toMatchObject({ id: 'fp-0000abcd', title: 'https://a.org/huge' });
    expect(page.because[0]).toMatch(/elements 4× its family’s median/);
    expect(q.items.some((i) => i.title === 'https://a.org/tiny')).toBe(false);
  });
});

function step(url: string, bytes: number, nodes: number, energyJ?: number): StepResult {
  return {
    scenario: 'crawl', step: url, run: 0, warmup: false, url, startedAt: 0, endedAt: 1, timing: { durationMs: 1 },
    network: { requests: 10, transferBytes: bytes, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {} },
    anatomy: { domNodes: nodes, domDepth: 10, cssRules: 0, cssSelectors: 0, scripts: 1, images: 1, iframes: 0, animatedElements: 0 },
    ...(energyJ !== undefined
      ? { energy: { raw: { adapterId: 'x', measurementType: 'observed', measurementScope: 'process', available: true, durationMs: 1000, sampleCount: 10 }, incrementalJoules: energyJ } as StepResult['energy'] }
      : {}),
    valid: true, warnings: [],
  };
}

describe('compareWithPrevious', () => {
  const before = resultWith([record('drupal-block:menu', { signals: ['On 3 of 3 pages.'] })], {
    session: { id: 'before', startedAt: '2026-10-01T10:00:00.000Z', mode: 'crawl' },
    scenarios: [step('https://a.org/', 400_000, 1500), step('https://a.org/news?page=2', 300_000, 1200), step('https://a.org/gone', 1, 1)],
  });
  const now = resultWith(
    [
      record('drupal-block:menu', { signals: ['On 3 of 3 pages.', '1 animation that never stops (spin).', 'Lighthouse (Chromium): layout shift, on 1 page.'] }),
      record('component:chat-widget'),
    ],
    { scenarios: [step('https://a.org/', 520_000, 1500), step('https://a.org/news?page=2', 300_000, 1210), step('https://a.org/new', 1, 1)] },
  );

  it('compares the pages measured in both, query included, and names the largest changes', () => {
    const h = compareWithPrevious(now, before, 'crawl-before.json');
    expect([h.pagesInBoth, h.pagesOnlyNow, h.pagesOnlyBefore]).toEqual([2, 1, 1]);
    expect(h.medians.transferBytes).toEqual([350_000, 410_000]);
    expect(h.largestChanges.map((c) => c.url)).toEqual(['https://a.org/']);
  });

  it('reports components new and gone, and new signals, comparing Lighthouse ones only when both scans ran it', () => {
    const h = compareWithPrevious(now, before, 'crawl-before.json');
    expect(h.components!.appeared).toEqual(['component:chat-widget']);
    expect(h.components!.newSignals.map((s) => s.signal)).toEqual(['1 animation that never stops (spin).', 'Lighthouse (Chromium): layout shift, on 1 page.']);
    const noLighthouseBefore = structuredClone(before);
    noLighthouseBefore.components!.lighthousePages = 0;
    expect(compareWithPrevious(now, noLighthouseBefore, 'x').components!.newSignals.map((s) => s.signal)).toEqual(['1 animation that never stops (spin).']);
  });

  it('explains a sample drawn in the older order, so fewer shared pages are not read as a change to the site', () => {
    const sampled = (r: BenchmarkResult, order?: 'url-hash') => ({ ...r, sampling: { method: 'adaptive' as const, picked: 3, ...(order ? { order } : {}) } });
    const changed = compareWithPrevious(sampled(now, 'url-hash'), sampled(before), 'x');
    expect(changed.limitations[0]).toMatch(/older order.*URL hash/);
    expect(compareWithPrevious(sampled(now, 'url-hash'), sampled(before, 'url-hash'), 'x').limitations[0]).not.toMatch(/older order/);
  });

  it('compares energy only when both scans measured and resolved it', () => {
    expect(compareWithPrevious(now, before, 'x').energy).toMatchObject({ comparable: false, note: expect.stringMatching(/not measured/) });
    const e = (r: BenchmarkResult, j: number[]) => ({ ...r, scenarios: j.map((x, i) => step(`https://a.org/${i}`, 1, 1, x)) });
    const h = compareWithPrevious(e(now, [0.02, 0.021, 0.022]), e(before, [0.018, 0.019, 0.02]), 'x');
    expect(h.energy.comparable).toBe(true);
    expect(h.energy.note).toMatch(/Indicative/);
    expect(compareWithPrevious(e(now, [0.02, -0.03, 0.001]), e(before, [0.018, 0.019, 0.02]), 'x').energy.comparable).toBe(false);
  });
});

describe('findPrevious', () => {
  const write = (dir: string, name: string, r: unknown) => writeFileSync(join(dir, name), JSON.stringify(r));
  const r = (id: string, startedAt: string, url: string) => ({ session: { id, startedAt, mode: 'crawl' }, target: { url }, scenarios: [] });

  it('takes the latest earlier scan of the same site, from the index when there is one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-'));
    write(dir, 'crawl-2026-10-01.json', r('a', '2026-10-01T00:00:00Z', 'https://www.a.org/'));
    write(dir, 'crawl-2026-10-10.json', r('b', '2026-10-10T00:00:00Z', 'https://a.org/'));
    write(dir, 'crawl-2026-10-20.json', r('c', '2026-10-20T00:00:00Z', 'https://other.org/'));
    write(dir, 'crawl-2026-12-01.json', r('d', '2026-12-01T00:00:00Z', 'https://a.org/'));
    const current = r('now', '2026-11-05T00:00:00Z', 'https://a.org/') as unknown as BenchmarkResult;
    expect((await findPrevious(dir, current))!.file).toBe('crawl-2026-10-10.json');
    write(dir, 'index.json', { entries: [{ file: 'crawl-2026-10-01.json', mode: 'crawl', timestamp: '2026-10-01T00:00:00Z', target: 'https://www.a.org/' }] });
    // The index is trusted for which file to read.
    expect((await findPrevious(dir, current))!.file).toBe('crawl-2026-10-01.json');
    expect(await findPrevious(dir, r('x', '2026-11-05T00:00:00Z', 'https://none.org/') as unknown as BenchmarkResult)).toBeUndefined();
  });
});

describe('investigation in the reports', () => {
  const carousel = record('component:carousel', { animations: { running: 1, infinite: 1, names: [] }, evidence: [finding('non-composited-animations')] });
  const steps = [{
    ...step('https://a.org/', 1, 1),
    anatomy: {
      ...step('https://a.org/', 1, 1).anatomy!,
      structure: { landmarks: [], components: [], frameworks: [], instances: [
        { signature: 'component:carousel', method: 'annotation' as const, selector: '.carousel', nodePath: '1,HTML,1,BODY,0,DIV', ancestry: [], nodes: 3, depth: 1, rect: { x: 0, y: 1200, width: 1000, height: 300 }, belowFold: true },
      ] },
    },
  }];
  const result = resultWith([carousel], { scenarios: steps });
  result.investigation = buildInvestigation(result);

  it('renders the order, a table, a decorative page map with a text equivalent, and no scripts', () => {
    const html = investigationSection(result);
    expect(html).toContain('<h2 id="investigate-h">Investigate first</h2>');
    expect(html).toContain('<strong>not a score</strong>');
    expect(html).toMatch(/<svg aria-hidden="true" focusable="false"/);
    expect(html).toMatch(/<ol class="map-list"><li value="1"><a href="#q-cmp-/);
    expect(html).toContain('1,200 px down');
    expect(html).toMatch(/<details id="q-cmp-/);
    expect(html).not.toMatch(/<script|<canvas|onclick/i);
  });

  it('writes the queue as CSV with each sort key in its own column', () => {
    const [head, row] = queueCsv(result).split('\n');
    expect(head).toBe('rank,kind,id,title,evidence,because,pages,of_pages,families,elements,share_of_page,endless_animations,chromium_main_thread_ms,transfer_bytes,remedies,verify,confidence,example_page,example_selector,lighthouse_audits');
    expect(row!.startsWith('1,component,cmp-')).toBe(true);
  });

  it('renders history with before and after, and says it is indicative', () => {
    const before = resultWith([], { session: { id: 'b', startedAt: '2026-10-01T00:00:00Z', mode: 'crawl' }, scenarios: [step('https://a.org/', 100_000, 1000)] });
    const now = resultWith([], { scenarios: [step('https://a.org/', 150_000, 1100)] });
    const html = historySection(compareWithPrevious(now, before, 'crawl-old.json'));
    expect(html).toContain('98 KB → 146 KB');
    expect(html).toContain('not comparable');
    expect(html).toMatch(/indicative/);
  });
});
