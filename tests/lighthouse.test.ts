import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  combineRuns,
  describeThrottling,
  extractRecommendations,
  medianRunIndex,
  scoreRating,
  sitewideRecommendations,
  summarizeLhr,
  type Lhr,
  type LighthouseRunSummary,
} from '../src/lighthouse/summary.js';
import { formFactorFor, parseCategories } from '../src/lighthouse/run.js';
import { pickLighthouseUrls } from '../src/lighthouse/select.js';
import type { StepResult } from '../src/core/types.js';

/**
 * A real Lighthouse 13.5 report (all four categories), trimmed to the fields
 * the summariser reads. The page behind it has a large unused stylesheet and
 * script, so it fails several performance audits on purpose.
 */
const lhr = JSON.parse(readFileSync('tests/fixtures/lhr-13-sample.json', 'utf8')) as Lhr;

const run = (performance: number, lcpMs: number, recs: string[] = []): LighthouseRunSummary => ({
  requestedUrl: 'https://example.org/',
  scores: { performance },
  metrics: { lcpMs, tbtMs: 10, cls: 0 },
  recommendations: recs.map((id) => ({ id, title: id, score: 0 })),
  failingAudits: {},
  work: {},
  warnings: [],
});

describe('summarizeLhr', () => {
  const s = summarizeLhr(lhr, 'https://example.org/');

  it('reports category scores out of 100', () => {
    expect(s.scores).toEqual({ performance: 68, accessibility: 95, 'best-practices': 96, seo: 91 });
  });

  it('ignores categories this tool does not publish', () => {
    expect(Object.keys(s.scores)).not.toContain('agentic-browsing');
  });

  it('extracts the lab metrics', () => {
    expect(s.metrics.lcpMs).toBeGreaterThan(0);
    expect(s.metrics.fcpMs).toBeGreaterThan(0);
    expect(s.metrics.tbtMs).toBeGreaterThanOrEqual(0);
    expect(s.metrics.cls).toBe(0);
    expect(s.metrics.speedIndexMs).toBeGreaterThan(0);
  });

  it('keeps the CPU and byte figures that relate to client energy', () => {
    expect(s.work.mainThreadMs).toBeGreaterThan(0);
    expect(s.work.jsExecutionMs).toBeGreaterThan(0);
    expect(s.work.totalBytes).toBe(822358);
    expect(s.work.unusedCssBytes).toBe(657780);
    expect(s.work.unusedJsBytes).toBe(157780);
    expect(s.work.domElements).toBe(6);
    const cats = s.work.mainThreadByCategory!;
    expect(cats[0]!.category).toBe('Script Evaluation');
    // Sorted largest first.
    for (let i = 1; i < cats.length; i++) expect(cats[i - 1]!.ms).toBeGreaterThanOrEqual(cats[i]!.ms);
  });

  it('lists failing audits for the non-performance categories', () => {
    expect(s.failingAudits.accessibility?.map((a) => a.id)).toContain('landmark-one-main');
    expect(s.failingAudits.seo?.map((a) => a.id)).toContain('meta-description');
    expect(s.failingAudits.performance).toBeUndefined();
  });

  it('records the CPU benchmark so slow runners can be spotted', () => {
    expect(s.benchmarkIndex).toBeGreaterThan(0);
  });

  it('turns a runtime error into an error and no recommendations', () => {
    const broken = { ...lhr, runtimeError: { code: 'NOT_HTML', message: 'The page provided is not HTML.' } };
    const r = summarizeLhr(broken, 'https://example.org/report.pdf');
    expect(r.error).toBe('NOT_HTML: The page provided is not HTML.');
    expect(r.recommendations).toEqual([]);
  });
});

describe('extractRecommendations', () => {
  const recs = extractRecommendations(lhr);
  const ids = recs.map((r) => r.id);

  it('includes failing insights and diagnostics', () => {
    expect(ids).toContain('render-blocking-insight');
    expect(ids).toContain('unused-css-rules');
    expect(ids).toContain('unused-javascript');
  });

  it('excludes metrics, passing, informative and not-applicable audits', () => {
    expect(ids).not.toContain('largest-contentful-paint');
    expect(ids).not.toContain('unminified-css'); // score 1
    expect(ids).not.toContain('long-tasks'); // informative
    expect(ids).not.toContain('lcp-discovery-insight'); // notApplicable
    expect(ids).not.toContain('redirects'); // hidden group
  });

  it('orders worst score first, then by estimated time saved', () => {
    for (let i = 1; i < recs.length; i++) {
      const a = recs[i - 1]!;
      const b = recs[i]!;
      expect(a.score ?? 1).toBeLessThanOrEqual(b.score ?? 1);
      if (a.score === b.score) expect(a.savingsMs ?? 0).toBeGreaterThanOrEqual(b.savingsMs ?? 0);
    }
  });

  it('carries estimated savings and the documentation link', () => {
    const css = recs.find((r) => r.id === 'unused-css-rules')!;
    expect(css.savingsBytes).toBe(657780);
    expect(css.savingsMs).toBeGreaterThan(0);
    expect(css.learnMore).toMatch(/^https:\/\/developer\.chrome\.com\//);
    // Lighthouse's non-breaking spaces are normalised.
    expect(css.displayValue).not.toMatch(/ /);
  });

  it('sums wasted bytes from items when no overall figure is given', () => {
    const cache = recs.find((r) => r.id === 'cache-insight')!;
    expect(cache.savingsBytes).toBeGreaterThan(800_000);
  });
});

describe('third-party parsing', () => {
  it('reads entity names, bytes and main-thread time', () => {
    const withThirdParties: Lhr = {
      ...lhr,
      audits: {
        ...lhr.audits,
        'third-parties-insight': {
          id: 'third-parties-insight',
          title: '3rd parties',
          score: 0,
          scoreDisplayMode: 'numeric',
          details: {
            type: 'table',
            items: [
              { entity: 'Google Tag Manager', transferSize: 120000.4, mainThreadTime: 310.2 },
              { entity: 'Qualtrics', transferSize: 50000 },
            ],
          },
        },
      },
    };
    expect(summarizeLhr(withThirdParties, 'https://example.org/').work.thirdParties).toEqual([
      { entity: 'Google Tag Manager', transferBytes: 120000, mainThreadMs: 310 },
      { entity: 'Qualtrics', transferBytes: 50000 },
    ]);
  });
});

describe('medianRunIndex', () => {
  it('picks the run with the median performance score', () => {
    expect(medianRunIndex([run(50, 3000), run(70, 2500), run(60, 2800)])).toBe(2);
  });

  it('breaks ties on LCP closest to the median', () => {
    expect(medianRunIndex([run(60, 4000), run(60, 2000), run(60, 2900)])).toBe(2);
  });

  it('returns -1 for no runs', () => {
    expect(medianRunIndex([])).toBe(-1);
  });
});

describe('combineRuns', () => {
  it('reports medians, the score range and the median run’s recommendations', () => {
    const r = combineRuns('https://example.org/', [
      run(50, 3000, ['a']),
      run(70, 2500, ['b']),
      run(60, 2800, ['c']),
    ]);
    expect(r.runs).toBe(3);
    expect(r.scores.performance).toBe(60);
    expect(r.performanceRange).toEqual([50, 70]);
    expect(r.metrics.lcpMs).toBe(2800);
    expect(r.recommendations.map((x) => x.id)).toEqual(['c']);
  });

  it('drops failed runs instead of averaging them in', () => {
    const failed = { ...run(0, 0), error: 'PROTOCOL_TIMEOUT: timed out' };
    const r = combineRuns('https://example.org/', [failed, run(80, 2000)]);
    expect(r.runs).toBe(1);
    expect(r.scores.performance).toBe(80);
    expect(r.performanceRange).toBeUndefined();
  });

  it('reports an error when every run failed', () => {
    const failed = { ...run(0, 0), error: 'NOT_HTML: not HTML' };
    const r = combineRuns('https://example.org/a.pdf', [failed, failed]);
    expect(r.runs).toBe(0);
    expect(r.error).toBe('NOT_HTML: not HTML');
    expect(r.scores).toEqual({});
  });
});

describe('sitewideRecommendations', () => {
  it('ranks failures by how many pages share them', () => {
    const results = [
      combineRuns('https://example.org/a', [run(50, 3000, ['unused-css', 'cache'])]),
      combineRuns('https://example.org/b', [run(50, 3000, ['unused-css'])]),
      combineRuns('https://example.org/c', [run(50, 3000, ['unused-css', 'cache', 'images'])]),
    ];
    const common = sitewideRecommendations(results);
    expect(common.map((c) => [c.id, c.pages])).toEqual([
      ['unused-css', 3],
      ['cache', 2],
      ['images', 1],
    ]);
  });
});

describe('helpers', () => {
  it('writes the rating out so it is not conveyed by colour alone', () => {
    expect(scoreRating(95)).toBe('good');
    expect(scoreRating(90)).toBe('good');
    expect(scoreRating(89)).toBe('needs improvement');
    expect(scoreRating(50)).toBe('needs improvement');
    expect(scoreRating(49)).toBe('poor');
    expect(scoreRating(undefined)).toBe('no score');
  });

  it('describes the throttling profile', () => {
    expect(describeThrottling(lhr)).toBe('simulate, 150 ms RTT, 1.6 Mbps, 4× CPU slowdown');
    expect(describeThrottling({ configSettings: { throttlingMethod: 'provided' } })).toBe('none (provided)');
  });

  it('maps desktop-width viewports to the desktop profile', () => {
    expect(formFactorFor({ width: 1440 })).toBe('desktop');
    expect(formFactorFor({ width: 1280 })).toBe('desktop');
    expect(formFactorFor({ width: 1024 })).toBe('mobile');
    expect(formFactorFor({ width: 390 })).toBe('mobile');
  });

  it('parses category lists', () => {
    expect(parseCategories(undefined)).toEqual(['performance']);
    expect(parseCategories('all')).toEqual(['performance', 'accessibility', 'best-practices', 'seo']);
    expect(parseCategories('performance, accessibility,performance')).toEqual(['performance', 'accessibility']);
    expect(() => parseCategories('speed')).toThrow(/performance, accessibility/);
  });
});

describe('pickLighthouseUrls', () => {
  const step = (name: string, bytes: number, valid = true, warning?: string): StepResult => ({
    scenario: 's',
    step: name,
    run: 0,
    warmup: false,
    startedAt: 0,
    endedAt: 1,
    timing: { durationMs: 1 },
    network: { requests: 1, transferBytes: bytes, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {} },
    valid,
    warnings: warning ? [warning] : [],
  });

  const steps = [
    step('https://example.org/', 500_000),
    step('https://example.org/big', 2_000_000),
    step('https://example.org/report', 0, false, 'Step failed: page.goto: Download is starting'),
    step('https://example.org/broken', 0, false, 'Step failed: net::ERR_NAME_NOT_RESOLVED'),
  ];

  it('skips file downloads in measure mode but keeps other failures', () => {
    const r = pickLighthouseUrls(steps, steps.map((s) => s.step), 'measure', 10);
    expect(r.urls).toEqual(['https://example.org/', 'https://example.org/big', 'https://example.org/broken']);
    expect(r.skipped).toEqual(['https://example.org/report']);
  });

  it('audits the heaviest crawled pages', () => {
    const r = pickLighthouseUrls(steps, ['https://example.org/'], 'crawl', 1);
    expect(r.urls).toEqual(['https://example.org/big']);
  });
});
