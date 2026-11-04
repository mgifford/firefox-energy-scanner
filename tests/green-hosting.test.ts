import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { toIndexEntry } from '../src/report/index-builder.js';
import type { BenchmarkResult } from '../src/core/types.js';
import { checkGreenHosting, estimateCo2, estimateCo2ByDomain, lookupGreenHosting } from '../src/core/co2.js';
import { buildStepResults, greenHostingFor, type StepRecord } from '../src/core/runner.js';
import { defaultConfig } from '../src/core/config.js';

/**
 * Green hosting per domain: a page's own bytes and its third parties' bytes
 * are often hosted in different places, so one flag for the page is wrong in
 * both directions.
 */

const resource = (domain: string, transferBytes: number) => ({
  url: `https://${domain}/x`,
  domain,
  thirdParty: false,
  resourceType: 'script',
  transferBytes,
});

function record(resources: ReturnType<typeof resource>[]): StepRecord {
  const transferBytes = resources.reduce((t, r) => t + r.transferBytes, 0);
  return {
    label: 'run:0:https://a.org/',
    url: 'https://a.org/',
    startedAt: 0,
    endedAt: 1,
    timing: { durationMs: 1 },
    network: { requests: resources.length, transferBytes, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {}, resources },
    valid: true,
    warnings: [],
  };
}

const withGreenCheck = () => {
  const config = defaultConfig();
  config.co2.check_green_hosting = true;
  return config;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimateCo2ByDomain', () => {
  it('equals the sum of a green and a grid-powered estimate', () => {
    const r = estimateCo2ByDomain(new Map([['a.org', 600_000], ['cdn.b.net', 400_000]]), new Map([['a.org', true]]), 'swd');
    const green = estimateCo2(600_000, { model: 'swd', greenHosting: true });
    const grid = estimateCo2(400_000, { model: 'swd', greenHosting: false });
    expect(r.estimatedGrams).toBeCloseTo(green.estimatedGrams + grid.estimatedGrams, 12);
    expect(r.dataCenterGrams).toBeCloseTo(green.dataCenterGrams! + grid.dataCenterGrams!, 12);
    expect(r).toMatchObject({ greenHostingChecked: true, greenHosting: false, greenBytes: 600_000, inputBytes: 1_000_000 });
  });

  it('is lower than the all-grid estimate when some bytes are green, and equal when none are', () => {
    const bytes = new Map([['a.org', 1_000_000]]);
    const grid = estimateCo2(1_000_000, { model: 'swd' }).estimatedGrams;
    expect(estimateCo2ByDomain(bytes, new Map([['a.org', true]]), 'swd').estimatedGrams).toBeLessThan(grid);
    expect(estimateCo2ByDomain(bytes, new Map(), 'swd').estimatedGrams).toBeCloseTo(grid, 12);
  });

  it('reports nothing checked, not 0% green, when no domain could be checked', () => {
    const r = estimateCo2ByDomain(new Map([['a.org', 10], ['b.org', 20]]), new Map(), 'swd');
    expect(r.greenHostingChecked).toBe(false);
    expect(r.greenBytes).toBeUndefined();
  });

  it('records the bytes whose hosting is unknown when only some were checked', () => {
    const r = estimateCo2ByDomain(new Map([['a.org', 10], ['b.org', 30]]), new Map([['a.org', true]]), 'swd');
    expect(r).toMatchObject({ greenHostingChecked: true, greenBytes: 10, greenUnknownBytes: 30 });
  });

  it('calls a page green-hosted only when every byte is', () => {
    const r = estimateCo2ByDomain(new Map([['a.org', 10], ['b.org', 20]]), new Map([['a.org', true], ['b.org', true]]), 'swd');
    expect(r.greenHosting).toBe(true);
  });
});

describe('greenHostingFor', () => {
  it('asks once per public domain, never for local ones, and only when enabled', async () => {
    const lookup = vi.fn(async (domains: string[]) => new Map(domains.map((d) => [d, d === 'a.org'] as [string, boolean])));
    const records = [
      record([resource('a.org', 100), resource('A.org', 50), resource('cdn.b.net', 10), resource('localhost', 5), resource('dev.ddev.site', 5)]),
    ];
    expect(await greenHostingFor(records, defaultConfig(), [], lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();

    const warnings: string[] = [];
    const green = await greenHostingFor(records, withGreenCheck(), warnings, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0].sort()).toEqual(['a.org', 'cdn.b.net']);
    expect(green?.get('a.org')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('warns when some domains could not be checked', async () => {
    const warnings: string[] = [];
    await greenHostingFor([record([resource('a.org', 1), resource('b.org', 1)])], withGreenCheck(), warnings, async () => new Map([['a.org', true]]));
    expect(warnings[0]).toMatch(/unknown for 1 of 2 domain\(s\)/);
  });
});

describe('buildStepResults with green hosting', () => {
  it('splits each step by domain when a lookup was made, and keeps one estimate when not', () => {
    const rec = record([resource('a.org', 700_000), resource('cdn.b.net', 300_000)]);
    const config = withGreenCheck();
    const [checked] = buildStepResults([rec], new Map(), undefined, config, 'measure', new Map([['a.org', true]]));
    expect(checked!.co2).toMatchObject({ greenHostingChecked: true, greenBytes: 700_000, inputBytes: 1_000_000 });

    const [unchecked] = buildStepResults([rec], new Map(), undefined, defaultConfig(), 'measure');
    expect(unchecked!.co2).toMatchObject({ greenHostingChecked: false, greenHosting: false, inputBytes: 1_000_000 });
    expect(unchecked!.co2!.greenBytes).toBeUndefined();
  });
});

describe('lookupGreenHosting', () => {
  // The multi-domain endpoint answers from a cache of known-green domains and
  // calls the rest grey, and returns an array the old code skipped: a scan of
  // thegreenwebfoundation.org reported every domain unknown, shown as 0% green.
  it('does one full check per domain, a few at a time', async () => {
    const urls: string[] = [];
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const domain = url.split('/greencheck/')[1]!;
      return new Response(JSON.stringify({ url: domain, green: domain.startsWith('g') }), { status: 200 });
    });
    const domains = Array.from({ length: 10 }, (_, i) => (i % 2 ? `g${i}.org` : `n${i}.org`));
    const out = await lookupGreenHosting([...domains, 'G1.org']);
    expect(urls).toHaveLength(10);
    expect(urls.every((u) => u.startsWith('https://api.thegreenwebfoundation.org/greencheck/'))).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(out.size).toBe(10);
    expect(out.get('g1.org')).toBe(true);
    expect(out.get('n0.org')).toBe(false);
  });

  it('leaves a domain unknown when its check fails, rather than calling it not green', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/down.org')) throw new Error('offline');
      return new Response(JSON.stringify({ url: 'up.org', green: true }), { status: 200 });
    });
    const out = await lookupGreenHosting(['down.org', 'up.org']);
    expect(out.has('down.org')).toBe(false);
    expect(out.get('up.org')).toBe(true);
  });
});

describe('checkGreenHosting', () => {
  // It once called hosting.check(), which the ES-module build of CO2.js does
  // not have; the TypeError was swallowed and every answer was "unknown".
  it('really asks the Greencheck API', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ url: 'a.org', green: true }), { status: 200 });
    });
    expect(await checkGreenHosting('a.org')).toBe(true);
    expect(urls).toEqual(['https://api.thegreenwebfoundation.org/greencheck/a.org']);
  });
});

describe('green share in the site index', () => {
  const fixture = () => JSON.parse(readFileSync('tests/fixtures/issue-6-downloads.json', 'utf8')) as BenchmarkResult;
  const withCo2 = (r: BenchmarkResult, green: number, unknown?: number) => {
    for (const s of r.scenarios) {
      if (s.co2) Object.assign(s.co2, { greenHostingChecked: true, greenBytes: s.co2.inputBytes * green, ...(unknown ? { greenUnknownBytes: s.co2.inputBytes * unknown } : {}) });
    }
    return r;
  };

  it('shows the green and unknown shares', () => {
    const row = toIndexEntry(withCo2(fixture(), 0.6, 0.1), 'x.json').scenarios.find((s) => !s.failed)!;
    expect(row.co2GreenShare).toBe(0.6);
    expect(row.co2GreenUnknownShare).toBe(0.1);
  });

  it('hides the share of an older result whose lookup failed entirely, instead of showing 0%', () => {
    const r = withCo2(fixture(), 0);
    r.warnings.push('Green hosting is unknown for 8 of 8 domain(s); their bytes are modelled as grid-powered.');
    const row = toIndexEntry(r, 'x.json').scenarios.find((s) => !s.failed)!;
    expect(row.co2GreenShare).toBeUndefined();
  });
});
