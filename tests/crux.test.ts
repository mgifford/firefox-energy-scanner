import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cruxApiKey,
  cruxTarget,
  describeCrux,
  fetchCrux,
  formatCruxShare,
  formatCruxValue,
  type CruxResult,
} from '../src/core/crux.js';
import { toHtml } from '../src/report/html.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSecrets, holdSecrets, loadDotEnv, parseDotEnv } from '../src/core/secrets.js';
import type { BenchmarkResult } from '../src/core/types.js';
import type { LighthouseSummary } from '../src/lighthouse/summary.js';

/**
 * A response shaped like the Chrome UX Report's, with invented numbers. The
 * live API needs a key, so the shape is what gets tested here; the first real
 * call is a manual step recorded in the docs.
 */
const PAYLOAD = {
  record: {
    key: { origin: 'https://example.com', formFactor: 'PHONE' },
    metrics: {
      largest_contentful_paint: {
        histogram: [
          { start: 0, end: 2500, density: 0.5 },
          { start: 2500, end: 4000, density: 0.3 },
          { start: 4000, density: 0.2 },
        ],
        percentiles: { p75: '3042' },
      },
      interaction_to_next_paint: {
        histogram: [
          { start: 0, end: 200, density: 0.7 },
          { start: 200, end: 500, density: 0.2 },
          { start: 500, density: 0.1 },
        ],
        percentiles: { p75: '242' },
      },
      cumulative_layout_shift: {
        histogram: [
          { start: '0.00', end: '0.10', density: 0.8 },
          { start: '0.10', end: '0.25', density: 0.15 },
          { start: '0.25', density: 0.05 },
        ],
        percentiles: { p75: '0.05' },
      },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 9, day: 7 },
      lastDate: { year: 2026, month: 10, day: 4 },
    },
  },
};

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function respondWith(payload: unknown, status = 200): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const KEY = 'test-key';

describe('cruxTarget', () => {
  it('derives the origin and keeps the URL', () => {
    expect(cruxTarget('https://example.com/a/b?c=1')).toEqual({
      url: 'https://example.com/a/b?c=1',
      origin: 'https://example.com',
    });
  });

  it('rejects a target that is not an absolute http(s) URL', () => {
    expect(() => cruxTarget('/relative')).toThrow(/absolute URL/);
    expect(() => cruxTarget('ftp://example.com/')).toThrow(/http\(s\)/);
  });

  it('refuses local, private and development targets before they leave the machine', () => {
    // The query carries the URL to Google, so these must never be sent.
    expect(() => cruxTarget('http://localhost:8080/')).toThrow(/Refusing to send localhost/);
    expect(() => cruxTarget('http://192.168.1.10/')).toThrow(/private or reserved/);
    expect(() => cruxTarget('https://preview.test/')).toThrow(/local or development/);
  });
});

describe('cruxApiKey', () => {
  it('prefers the flag over the environment', () => {
    expect(cruxApiKey('flag-key', { CRUX_API_KEY: 'env-key' })).toBe('flag-key');
  });

  it('falls back to the environment', () => {
    expect(cruxApiKey(undefined, { CRUX_API_KEY: 'env-key' })).toBe('env-key');
  });

  it('names both ways to supply a key when there is none', () => {
    expect(() => cruxApiKey(undefined, {})).toThrow(/CRUX_API_KEY=… in a \.env file.*CRUX_API_KEY environment variable/);
  });
});

describe('fetchCrux', () => {
  it('queries the origin by default and keeps the p75 plus the bands', async () => {
    const { impl, calls } = respondWith(PAYLOAD);
    const result = await fetchCrux({ target: 'https://example.com/a', apiKey: KEY, fetchImpl: impl });

    expect(result.status).toBe('ok');
    expect(calls[0]!.body).toEqual({ origin: 'https://example.com' });

    const record = result.record!;
    expect(record.scope).toBe('origin');
    expect(record.metrics.lcp?.p75).toBe(3042);
    expect(record.metrics.lcp?.band).toEqual({ good: 0.5, needsImprovement: 0.3, poor: 0.2 });
    expect(record.metrics.cls?.p75).toBe(0.05);
    expect(record.window).toEqual({ start: '2026-09-07', end: '2026-10-04' });
  });

  it('asks about the URL itself when that scope is requested', async () => {
    const { impl, calls } = respondWith(PAYLOAD);
    await fetchCrux({
      target: 'https://example.com/a',
      scope: 'url',
      apiKey: KEY,
      fetchImpl: impl,
    });
    expect(calls[0]!.body).toEqual({ url: 'https://example.com/a' });
  });

  it('passes a form factor through, and omits it when aggregating all', async () => {
    const one = respondWith(PAYLOAD);
    await fetchCrux({
      target: 'https://example.com/',
      formFactor: 'PHONE',
      apiKey: KEY,
      fetchImpl: one.impl,
    });
    expect(one.calls[0]!.body.formFactor).toBe('PHONE');

    const all = respondWith(PAYLOAD);
    await fetchCrux({ target: 'https://example.com/', apiKey: KEY, fetchImpl: all.impl });
    expect(all.calls[0]!.body).not.toHaveProperty('formFactor');
  });

  it('reports a missing record as no data, not as a failure', async () => {
    const { impl } = respondWith(
      { error: { code: 404, message: 'chrome ux report data not found' } },
      404,
    );
    const result = await fetchCrux({ target: 'https://example.com/', apiKey: KEY, fetchImpl: impl });
    expect(result.status).toBe('no-data');
    expect(result.detail).toMatch(/real Chrome traffic/);
  });

  it('reports an API error without echoing the key', async () => {
    const { impl } = respondWith(
      { error: { code: 403, message: 'API key not valid. Please pass a valid API key.' } },
      403,
    );
    const result = await fetchCrux({ target: 'https://example.com/', apiKey: KEY, fetchImpl: impl });
    expect(result.status).toBe('error');
    expect(result.detail).toContain('HTTP 403');
    expect(result.detail).toContain('API key not valid');
    expect(result.detail).not.toContain(KEY);
  });

  it('reports an unreachable API as an error', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const result = await fetchCrux({ target: 'https://example.com/', apiKey: KEY, fetchImpl: impl });
    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/could not reach/);
  });

  it('refuses a private target instead of sending it', async () => {
    const { impl, calls } = respondWith(PAYLOAD);
    await expect(
      fetchCrux({ target: 'http://localhost:8080/', apiKey: KEY, fetchImpl: impl }),
    ).rejects.toThrow(/Refusing to send/);
    expect(calls).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('uses seconds, milliseconds and unitless values in their natural unit', () => {
    expect(formatCruxValue('lcp', 3042)).toBe('3.0 s');
    expect(formatCruxValue('inp', 242)).toBe('242 ms');
    expect(formatCruxValue('cls', 0.05)).toBe('0.05');
  });

  it('renders shares as whole percentages', () => {
    expect(formatCruxShare(0.5)).toBe('50%');
    expect(formatCruxShare(0.075)).toBe('8%');
  });

  it('states scope, form factor and window beside every figure', () => {
    const record = PAYLOAD.record;
    const result: CruxResult = {
      scope: 'origin',
      target: 'https://example.com',
      formFactor: 'ALL',
      status: 'ok',
      record: {
        scope: 'origin',
        id: 'https://example.com',
        formFactor: 'PHONE',
        window: { start: '2026-09-07', end: '2026-10-04' },
        metrics: {
          lcp: { p75: record.metrics.largest_contentful_paint.percentiles.p75 as unknown as number, band: { good: 0.5, needsImprovement: 0.3, poor: 0.2 } },
        },
      },
    };
    expect(describeCrux(result)).toBe(
      'Origin https://example.com, phone, 28 days, 2026-09-07 to 2026-10-04',
    );
  });
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const base = JSON.parse(
  readFileSync('tests/fixtures/issue-6-downloads.json', 'utf8'),
) as BenchmarkResult;

const OK: CruxResult = {
  scope: 'origin',
  target: 'https://example.com',
  formFactor: 'ALL',
  status: 'ok',
  record: {
    scope: 'origin',
    id: 'https://example.com',
    formFactor: 'ALL',
    window: { start: '2026-09-07', end: '2026-10-04' },
    metrics: {
      lcp: { p75: 3042, band: { good: 0.5, needsImprovement: 0.3, poor: 0.2 } },
      inp: { p75: 242, band: { good: 0.7, needsImprovement: 0.2, poor: 0.1 } },
      cls: { p75: 0.05, band: { good: 0.8, needsImprovement: 0.15, poor: 0.05 } },
    },
  },
};

const NO_DATA: CruxResult = {
  scope: 'url',
  target: 'https://example.com/preview',
  formFactor: 'ALL',
  status: 'no-data',
  detail: 'CrUX holds no record for this url.',
};

const LAB = {
  version: '13.5.0',
  runsPerUrl: 1,
  formFactor: 'desktop',
  throttling: 'simulated',
  categories: ['performance'],
  results: [
    {
      requestedUrl: 'https://example.com/',
      runs: 1,
      scores: { performance: 90 },
      metrics: { lcpMs: 1200, fcpMs: 900, cls: 0.01, tbtMs: 10 },
      recommendations: [],
      failingAudits: {},
      work: { mainThreadMs: 500, totalBytes: 1000 },
      warnings: [],
    },
  ],
} as unknown as LighthouseSummary;

const withCrux = (crux: CruxResult, lh?: LighthouseSummary): BenchmarkResult => ({
  ...base,
  crux,
  ...(lh ? { lighthouse: lh } : {}),
});

describe('field data section', () => {
  it('renders the p75 and the band shares, with the window beside them', () => {
    const html = toHtml(withCrux(OK));
    expect(html).toContain('Field data (CrUX)');
    expect(html).toContain('Largest Contentful Paint');
    expect(html).toContain('3.0 s');
    expect(html).toContain('50%');
    expect(html).toContain('28 days, 2026-09-07 to 2026-10-04');
  });

  it('states that no record exists instead of rendering an empty table', () => {
    const html = toHtml(withCrux(NO_DATA));
    expect(html).toContain('No field data');
    expect(html).toContain('CrUX holds no record for this url');
    expect(html).not.toContain('Field measurements over the last 28 days');
  });

  it('renders nothing at all when field data was not requested', () => {
    expect(toHtml(base)).not.toContain('Field data (CrUX)');
  });

  it('shows field and lab side by side for a single audited page', () => {
    const html = toHtml(withCrux(OK, LAB));
    expect(html).toContain('Field against lab');
    expect(html).toContain('Field p75 (CrUX)');
    expect(html).toContain('1.2 s');
    // INP has no lab counterpart, and TBT must not be presented as one.
    expect(html).toMatch(/Interaction to Next Paint has no lab counterpart/);
  });

  it('refuses to pair an origin record with a multi-page lab table', () => {
    const multi = {
      ...LAB,
      results: [LAB.results[0]!, { ...LAB.results[0]!, requestedUrl: 'https://example.com/about' }],
    } as unknown as LighthouseSummary;
    const html = toHtml(withCrux(OK, multi));
    expect(html).not.toContain('Field against lab');
    expect(html).toContain('while Lighthouse audited 2 individual pages');
  });
});

describe('the API key stays out of URLs, results and child processes', () => {
  it('travels in the X-Goog-Api-Key header, never the URL', async () => {
    const { impl, calls } = respondWith(PAYLOAD);
    await fetchCrux({ target: 'https://example.com/a', apiKey: 'secret-123', fetchImpl: impl });
    expect(calls[0]!.url).toBe('https://chromeuxreport.googleapis.com/v1/records:queryRecord');
    expect(calls[0]!.url).not.toContain('secret-123');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('secret-123');
  });

  it('is not in a result, an error or a refusal', async () => {
    const outcomes = [
      await fetchCrux({ target: 'https://example.com/', apiKey: 'secret-123', fetchImpl: respondWith(PAYLOAD).impl }),
      await fetchCrux({ target: 'https://example.com/', apiKey: 'secret-123', fetchImpl: respondWith({ error: { message: 'API key not valid.' } }, 400).impl }),
      await fetchCrux({ target: 'https://example.com/', apiKey: 'secret-123', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }),
    ];
    for (const o of outcomes) expect(JSON.stringify(o)).not.toContain('secret-123');
  });
});

describe('.env and held secrets', () => {
  it('reads KEY=value lines, comments, export and quotes', () => {
    expect(parseDotEnv('# keys\nexport CRUX_API_KEY="abc 123"\nDRUPAL_USERNAME=admin # local\n\nBAD LINE\nEMPTY=\n')).toEqual({ CRUX_API_KEY: 'abc 123', DRUPAL_USERNAME: 'admin', EMPTY: '' });
  });

  it('loads .env without overriding what the environment already sets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    writeFileSync(join(dir, '.env'), 'CRUX_API_KEY=from-file\nOTHER=x\n');
    const env: NodeJS.ProcessEnv = { OTHER: 'from-shell' };
    expect(loadDotEnv(dir, env)).toEqual(['CRUX_API_KEY']);
    expect(env).toEqual({ OTHER: 'from-shell', CRUX_API_KEY: 'from-file' });
    expect(loadDotEnv(join(dir, 'missing'), {})).toEqual([]);
  });

  it('takes the key out of the environment, so browsers launched later do not inherit it', () => {
    const env: NodeJS.ProcessEnv = { CRUX_API_KEY: ' held-key ', PATH: '/usr/bin' };
    holdSecrets(env);
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(cruxApiKey(undefined, env)).toBe('held-key');
    forgetSecrets();
    expect(() => cruxApiKey(undefined, env)).toThrow();
  });
});
