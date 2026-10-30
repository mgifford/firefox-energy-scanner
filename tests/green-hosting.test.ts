import { describe, it, expect, vi, afterEach } from 'vitest';
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
  it('asks the Greencheck API in batches and reads each domain it answers for', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const domains = JSON.parse(decodeURIComponent(url.split('/greencheckmulti/')[1]!)) as string[];
      const body = Object.fromEntries(domains.map((d) => [d, { url: d, green: d.startsWith('g') }]));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const domains = Array.from({ length: 25 }, (_, i) => (i % 2 ? `g${i}.org` : `n${i}.org`));
    const out = await lookupGreenHosting(domains);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('api.thegreenwebfoundation.org/v2/greencheckmulti/');
    expect(out.size).toBe(25);
    expect(out.get('g1.org')).toBe(true);
    expect(out.get('n0.org')).toBe(false);
  });

  it('leaves domains unknown when the API fails, rather than calling them not green', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const out = await lookupGreenHosting(['a.org']);
    expect(out.has('a.org')).toBe(false);
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
