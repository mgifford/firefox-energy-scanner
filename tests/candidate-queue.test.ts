import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCandidateQueue, parseAllowlist, allowedBy } from '../src/analysis/candidate-queue.js';
import { candidateQueueJsonSchema, validateCandidateQueue } from '../src/model/candidate-queue.js';
import type { BenchmarkResult } from '../src/core/types.js';
import type { InvestigationItem } from '../src/analysis/investigation.js';

const item = (rank: number, id: string, page: string, opts: { selector?: string; remediation?: boolean } = {}): InvestigationItem => ({
  rank,
  kind: 'component',
  id,
  title: `component:${id}`,
  evidence: 'structure',
  because: ['a structural fact'],
  reach: { pages: 1, of: 1, families: 1 },
  workload: { elements: 10 },
  remediation: opts.remediation === false ? [] : [{ id: 'animation', title: 'Pause the animation', action: 'Pause', rationale: 'r', verify: 'v', experiment: 'animation', references: [] }],
  confidence: 'low',
  where: [{ page, ...(opts.selector ? { selector: opts.selector } : {}) }],
  audits: [],
});

const result = (items: InvestigationItem[]): BenchmarkResult => ({
  schemaVersion: 2,
  session: { id: 'session-1', startedAt: '2026-11-18T00:00:00.000Z', mode: 'crawl' },
  environment: {
    timestamp: '2026-11-18T00:00:00.000Z',
    os: 'darwin',
    osVersion: 'test',
    architecture: 'arm64',
    cpuCount: 8,
    totalMemoryBytes: 1,
    energyAdapter: 'noop',
    headed: true,
    viewport: { width: 1440, height: 900 },
  },
  target: { url: 'https://www.site.test/' },
  configuration: {},
  scenarios: [],
  capabilities: { tier: 'structural', summary: 'structural', unavailable: [] },
  investigation: {
    method: 'test-v1',
    order: ['evidence'],
    items,
    limitations: [],
  },
});

describe('the bounded candidate queue', () => {
  it('selects within budgets and rejects allowlist, duplicate and no-remedy items', () => {
    const r = result([
      item(1, 'nav', 'https://www.site.test/articles/d', { selector: 'nav' }),
      item(2, 'card', 'https://www.site.test/articles/d', { selector: 'article' }),
      item(3, 'other', 'https://other.example.org/page', { selector: 'main' }),
      item(4, 'nav', 'https://www.site.test/articles/d', { selector: 'nav' }),
      item(5, 'no-remedy', 'https://www.site.test/articles/d', { remediation: false }),
    ]);
    const q = buildCandidateQueue(r, { sourceFile: 'fixture-result.json', sourceSha256: 'abc' });
    expect(validateCandidateQueue(q)).toEqual([]);
    expect(q.summary).toMatchObject({ candidates: 5, selected: 1, rejected: 4, uniquePages: 1, estimatedEnergyRuns: 24 });
    expect(q.selected[0]).toMatchObject({ status: 'selected', id: expect.stringMatching(/^cq-/), rank: 1 });
    expect(q.selected[0]!.experiment?.kind).toBe('pause-animations');
    expect(q.selected[0]!.pairing).toMatchObject({ page: 'https://www.site.test/articles/d', viewport: { width: 1440, height: 900 }, run: { sessionId: 'session-1' } });
    expect(q.rejected.map((c) => c.reason)).toEqual([
      expect.stringMatching(/^over-energy-budget/),
      expect.stringMatching(/^not-allowlisted/),
      expect.stringMatching(/^duplicate/),
      expect.stringMatching(/^no-experiment/),
    ]);
    expect(q.source).toMatchObject({ file: 'fixture-result.json', sha256: 'abc', targetUrl: 'https://www.site.test/', energyTier: 'structural' });
    expect(q.limitations.join(' ')).toMatch(/never starts|starts no browser/);
  });

  it('gives the same queue id for the same source and policy', () => {
    const r = result([item(1, 'nav', 'https://www.site.test/articles/d', { selector: 'nav' })]);
    const a = buildCandidateQueue(r, { sourceFile: 'fixture-result.json' });
    const b = buildCandidateQueue(r, { sourceFile: 'fixture-result.json' });
    expect(a.queueId).toBe(b.queueId);
    expect(a.selected[0]!.id).toBe(b.selected[0]!.id);
  });

  it('can select a no-experiment lead when the policy allows it', () => {
    const r = result([item(1, 'other', 'https://other.example.org/page', { selector: 'main', remediation: false })]);
    const q = buildCandidateQueue(r, {
      sourceFile: 'fixture-result.json',
      allowlist: [{ kind: 'host', value: 'other.example.org' }],
      requireRemedy: false,
    });
    expect(q.summary.selected).toBe(1);
    expect(q.selected[0]!.experiment).toBeUndefined();
    expect(q.selected[0]!.estimatedEnergyRuns).toBe(0);
  });

  it('parses host, url, prefix and bare host rules', () => {
    expect(parseAllowlist('# comment\nhost:www.example.org\nhttps://example.org/a\nurl:https://example.org/b\nprefix:https://example.org/blog/')).toEqual([
      { kind: 'host', value: 'www.example.org' },
      { kind: 'host', value: 'https://example.org/a' },
      { kind: 'url', value: 'https://example.org/b' },
      { kind: 'prefix', value: 'https://example.org/blog/' },
    ]);
    const rules = parseAllowlist('host:example.org\nprefix:https://example.org/blog/');
    expect(allowedBy('https://example.org/x', rules)).toBe(true);
    expect(allowedBy('https://www.example.org/x', rules)).toBe(false);
    expect(allowedBy('https://example.org/blog/post', rules)).toBe(true);
  });

  it('keeps the published schema in step', () => {
    expect(JSON.parse(readFileSync('schema/candidate-queue.schema.json', 'utf8'))).toEqual(candidateQueueJsonSchema());
  });
});
