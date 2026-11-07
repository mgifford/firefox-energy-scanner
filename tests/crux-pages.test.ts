import { describe, it, expect } from 'vitest';
import { CruxPages } from '../src/core/crux-pages.js';
import { adaptiveSample, sampleFromSitemaps, seededSample } from '../src/collect/sitemap.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';
import { pageKey, siteOf } from '../src/collect/urls.js';
import { defaultConfig } from '../src/core/config.js';
import { cruxPagesSection } from '../src/report/crux-pages-html.js';

/** A CrUX API that has records for some URLs, answers 404 for others, and counts calls. */
function crux(withRecord: (url: string) => boolean, status?: (n: number) => number) {
  const asked: string[] = [];
  const keys: string[] = [];
  const impl = (async (_url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const { url } = JSON.parse(String(init?.body)) as { url: string };
    asked.push(url);
    keys.push(init?.headers?.['x-goog-api-key'] ?? '');
    const code = status?.(asked.length) ?? (withRecord(url) ? 200 : 404);
    const body = code === 200
      ? { record: { key: { url }, metrics: { largest_contentful_paint: { histogram: [{ density: 0.8 }, { density: 0.15 }, { density: 0.05 }], percentiles: { p75: 2100 } } }, collectionPeriod: { firstDate: { year: 2026, month: 10, day: 1 }, lastDate: { year: 2026, month: 10, day: 28 } } } }
      : { error: { message: code === 429 ? 'Quota exceeded.' : 'chrome ux report data not found' } };
    return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, asked, keys };
}
const noSleep = async () => {};

describe('CrUX for many pages', () => {
  it('checks each URL once, within its budget, and says which have real Chrome traffic', async () => {
    const api = crux((u) => u.endsWith('/popular'));
    const field = new CruxPages({ apiKey: 'k', max: 3, fetchImpl: api.impl, sleep: noSleep });
    const urls = ['https://a.gov/popular', 'https://a.gov/quiet', 'https://a.gov/popular', 'https://a.gov/x', 'https://a.gov/y'];
    expect([...(await field.withRecord(urls))]).toEqual(['https://a.gov/popular']);
    expect(api.asked).toEqual(['https://a.gov/popular', 'https://a.gov/quiet', 'https://a.gov/x']);
    expect(field.queried).toBe(3);
    // Known answers are reused: no new query, however often asked.
    await field.check(['https://a.gov/popular']);
    expect(api.asked).toHaveLength(3);
    expect(api.keys.every((k) => k === 'k')).toBe(true);
  });

  it('paces its queries to stay inside the API quota', async () => {
    const waits: number[] = [];
    const field = new CruxPages({ apiKey: 'k', max: 5, intervalMs: 420, fetchImpl: crux(() => true).impl, sleep: async (ms) => void waits.push(ms) });
    await field.check(['https://a.gov/1', 'https://a.gov/2', 'https://a.gov/3']);
    expect(waits.length).toBe(2);
    expect(waits.every((w) => w > 0 && w <= 420)).toBe(true);
  });

  it('stops at a quota or key error rather than asking again and again', async () => {
    const api = crux(() => true, (n) => (n === 2 ? 429 : 200));
    const field = new CruxPages({ apiKey: 'k', max: 10, fetchImpl: api.impl, sleep: noSleep });
    await field.check(['https://a.gov/1', 'https://a.gov/2', 'https://a.gov/3']);
    expect(api.asked).toHaveLength(2);
    expect(field.stoppedBecause).toMatch(/HTTP 429/);
  });

  it('never sends a private, local or development address', async () => {
    const api = crux(() => true);
    const field = new CruxPages({ apiKey: 'k', max: 10, fetchImpl: api.impl, sleep: noSleep });
    await field.check(['http://localhost:8080/', 'http://www.site.test:8082/', 'https://mysite.ddev.site/', 'http://192.168.1.4/', 'https://a.gov/']);
    expect(api.asked).toEqual(['https://a.gov/']);
  });
});

describe('a sample that prefers pages people use', () => {
  it('puts preferred pages first, each part still in hash order', () => {
    const items = Array.from({ length: 20 }, (_, i) => `https://a.gov/p${i}`);
    const plain = seededSample(items, 5, 'a.gov');
    const prefer = new Set([items[17]!, items[3]!]);
    const preferred = seededSample(items, 5, 'a.gov', undefined, prefer);
    expect(new Set(preferred.slice(0, 2))).toEqual(prefer);
    expect(preferred.slice(2)).toEqual(plain.filter((u) => !prefer.has(u)).slice(0, 3));
  });

  it('lets a popular page lead its own section, without moving sections', () => {
    const groups = new Map([
      ['/news', Array.from({ length: 30 }, (_, i) => `https://a.gov/news/n${i}`)],
      ['/services', Array.from({ length: 10 }, (_, i) => `https://a.gov/services/s${i}`)],
    ]);
    const plain = adaptiveSample(groups, 2, 'a.gov').picks;
    const popular = new Set(['https://a.gov/news/n29']);
    const picks = adaptiveSample(groups, 2, 'a.gov', undefined, popular).picks;
    expect(picks.find((p) => p.key === '/news')!.url).toBe('https://a.gov/news/n29');
    expect(picks.find((p) => p.key === '/services')).toEqual(plain.find((p) => p.key === '/services'));
  });

  it('asks about the first few pages of every section before any section’s fourth, and records what it found', async () => {
    const sections = ['news', 'services', 'about', 'data'];
    const urls = sections.flatMap((s, si) => Array.from({ length: 10 + si }, (_, i) => `https://a.gov/${s}/p${i}`));
    const xml = `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
    const askedFor: string[][] = [];
    const sample = (await sampleFromSitemaps('https://a.gov/', {
      get: async (url) => (new URL(url).pathname === '/sitemap.xml' ? { ok: true, url, text: xml } : { ok: false, url, text: '' }),
      robotsSitemaps: [],
      maxPages: 5,
      strategy: 'adaptive',
      siteOf,
      pageKey: (u) => pageKey(u),
      select: (l, sites) => selectCrawlLinks(l, 'https://a.gov/', sites, defaultConfig().crawl),
      popular: async (candidates) => {
        askedFor.push(candidates);
        const withRecord = new Set(candidates.filter((u) => /\/p(7|8)$/.test(u)));
        return { withRecord, checked: candidates.length };
      },
    }))!;
    expect(askedFor).toHaveLength(1);
    expect(askedFor[0]).toHaveLength(12); // three a section, four sections
    expect(new Set(askedFor[0]!.slice(0, 4).map((u) => u.split('/')[3]))).toEqual(new Set(sections));
    expect(sample.popularity).toEqual({ checked: 12, withRecord: expect.any(Number) });
    // Where a section has a popular candidate, its representative is one.
    const reps = Object.entries(sample.reasons).filter(([, r]) => r === 'representative').map(([u]) => u);
    const popularAsked = askedFor[0]!.filter((u) => /\/p(7|8)$/.test(u));
    for (const s of new Set(popularAsked.map((u) => u.split('/')[3]))) {
      expect(reps.some((u) => u.includes(`/${s}/`) && popularAsked.includes(u))).toBe(true);
    }
  });
});

describe('the field data section of the report', () => {
  it('shows each page’s p75 figures, and says plainly what a missing record means', () => {
    const html = cruxPagesSection([
      { scope: 'url', target: 'https://a.gov/', formFactor: 'ALL', status: 'ok', record: { scope: 'url', id: 'https://a.gov/', formFactor: 'ALL', window: { start: '2026-10-01', end: '2026-10-28' }, metrics: { lcp: { p75: 2100, band: { good: 0.8, needsImprovement: 0.15, poor: 0.05 } } } } },
      { scope: 'url', target: 'https://a.gov/quiet', formFactor: 'ALL', status: 'no-data' },
    ]);
    expect(html).toContain('<caption>75th percentile, real Chrome users, by page</caption>');
    expect(html).toContain('1 of 2 measured pages have a Chrome UX Report record');
    expect(html).toContain('2026-10-01 to 2026-10-28');
    expect(html).toContain('<td>2.1 s</td>');
    expect(html).toContain('No record: too little Chrome traffic, or not covered');
    expect(html).toContain('not combined with it');
  });
});
