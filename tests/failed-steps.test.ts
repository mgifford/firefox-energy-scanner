import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeStepFailure, isNotAPage, readableFailure } from '../src/core/failures.js';
import { failedSteps, groupByStep } from '../src/report/csv.js';
import { toIndexEntry } from '../src/report/index-builder.js';
import { toHtml } from '../src/report/html.js';
import type { BenchmarkResult } from '../src/core/types.js';

/**
 * Three cms.gov URLs from the scan in issue #6: one HTML page, and two that
 * serve PDFs. Firefox started a download for each PDF, the navigation threw,
 * and the old index published those rows with the previous page's URL and
 * with bytes that belonged to the neighbouring step.
 */
const issue6 = JSON.parse(readFileSync('tests/fixtures/issue-6-downloads.json', 'utf8')) as BenchmarkResult;
const PAGE =
  'https://cms.gov/data-research/monitoring-programs/improper-payment-measurement-programs/payment-error-rate-measurement-perm/perm-error-rate-findings-and-reports';
const PDF = 'https://cms.gov/priorities/innovation/data-and-reports/2020/cpc-evaluation-findings-annual-report-2';

describe('describeStepFailure', () => {
  it('explains a file download in plain terms', () => {
    const w = describeStepFailure('page.goto: Download is starting\nCall log: ...');
    expect(w).toMatch(/^Not a web page: /);
    expect(w).toMatch(/PDF/);
  });

  it('keeps other errors verbatim', () => {
    expect(describeStepFailure('net::ERR_NAME_NOT_RESOLVED')).toBe('Step failed: net::ERR_NAME_NOT_RESOLVED');
  });

  it('rewrites warnings stored before downloads were detected', () => {
    const old = 'Step failed: page.goto: Download is starting\nCall log:\n  - navigating';
    expect(readableFailure(old)).toMatch(/^Not a web page: /);
    expect(isNotAPage(old)).toBe(true);
    expect(isNotAPage('Step failed: timeout')).toBe(false);
    expect(isNotAPage(undefined)).toBe(false);
  });
});

describe('failed runs are excluded from summaries', () => {
  it('groupByStep keeps only valid measured runs', () => {
    const groups = groupByStep(issue6.scenarios);
    expect([...groups.keys()]).toEqual([PAGE]);
    expect(groups.get(PAGE)!.every((r) => r.valid && !r.warmup)).toBe(true);
  });

  it('failedSteps names each URL that never succeeded', () => {
    const failed = failedSteps(issue6.scenarios);
    expect(failed.map((f) => f.step)).toEqual([PDF, expect.stringContaining('ocm-annual-report-2')]);
    expect(failed.every((f) => isNotAPage(f.reason))).toBe(true);
  });
});

describe('index entry for the issue #6 scan', () => {
  const entry = toIndexEntry(issue6, 'measure.json');

  it('marks the PDF URLs as not-a-page with no borrowed numbers', () => {
    const pdf = entry.scenarios.find((s) => s.step === PDF)!;
    expect(pdf.failed).toBe(true);
    expect(pdf.notAPage).toBe(true);
    expect(pdf.failureNote).toMatch(/^Not a web page: /);
    expect(pdf.url).toBeUndefined();
    expect(pdf.transferBytes).toBe(0);
    expect(pdf.co2Grams).toBeUndefined();
  });

  it('leaves the real page untouched', () => {
    const page = entry.scenarios.find((s) => s.step === PAGE)!;
    expect(page.failed).toBeUndefined();
    expect(page.runs).toBe(8);
    expect(page.transferBytes).toBeGreaterThan(400_000);
  });

  it('declares that this host could not measure energy', () => {
    expect(entry.energyAvailable).toBe(false);
    expect(entry.tier).toBe('structural');
  });

  it('lists the PDFs under "Not measured" in the HTML report', () => {
    const html = toHtml(issue6);
    expect(html).toContain('id="failed-h"');
    expect(html).toContain('cpc-evaluation-findings-annual-report-2');
    expect(html).toMatch(/Not a web page/);
  });
});

describe('index entry with Lighthouse', () => {
  const withLighthouse: BenchmarkResult = {
    ...issue6,
    lighthouse: {
      tool: 'lighthouse',
      version: '13.5.0',
      formFactor: 'desktop',
      throttling: 'simulate, 40 ms RTT, 10.0 Mbps, 1× CPU slowdown',
      categories: ['performance'],
      runsPerUrl: 3,
      results: [
        {
          requestedUrl: PAGE,
          runs: 3,
          scores: { performance: 62 },
          performanceRange: [58, 66],
          metrics: { lcpMs: 3100, tbtMs: 420, cls: 0.02 },
          recommendations: [
            { id: 'unused-javascript', title: 'Reduce unused JavaScript', score: 0, savingsBytes: 250_000 },
          ],
          failingAudits: {},
          work: { mainThreadMs: 2400, totalBytes: 760_000 },
          warnings: [],
        },
      ],
    },
  };
  const entry = toIndexEntry(withLighthouse, 'measure.json');

  it('attaches each result to the scenario for the same URL', () => {
    const page = entry.scenarios.find((s) => s.step === PAGE)!;
    expect(page.lighthouse?.scores.performance).toBe(62);
    expect(page.lighthouse?.performanceRange).toEqual([58, 66]);
    expect(page.lighthouse?.mainThreadMs).toBe(2400);
    expect(page.lighthouse?.recommendations[0]?.title).toBe('Reduce unused JavaScript');
    expect(entry.scenarios.find((s) => s.step === PDF)!.lighthouse).toBeUndefined();
  });

  it('carries run-level context and the shared recommendations', () => {
    expect(entry.lighthouse?.version).toBe('13.5.0');
    expect(entry.lighthouse?.formFactor).toBe('desktop');
    expect(entry.lighthouse?.sitewide.map((s) => s.id)).toEqual(['unused-javascript']);
    expect(entry.lighthouse?.unmatched).toBeUndefined();
  });

  it('renders a separate Lighthouse section in the HTML report', () => {
    const html = toHtml(withLighthouse);
    expect(html).toContain('id="lh-h"');
    expect(html).toContain('needs improvement');
    expect(html).toContain('Reduce unused JavaScript');
  });
});
