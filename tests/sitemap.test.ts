import { describe, it, expect } from 'vitest';
import {
  adaptiveSample,
  parseRobotsSitemaps,
  parseSitemapXml,
  sampleFromSitemaps,
  seededSample,
  type Fetched,
} from '../src/collect/sitemap.js';
import { describeSample, selectCrawlLinks } from '../src/collect/crawler.js';
import { pageKey, siteOf } from '../src/collect/urls.js';
import { defaultConfig } from '../src/core/config.js';

const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;
const index = (locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;

/** A fake site: path -> body, with an optional redirect to another host. */
function site(pages: Record<string, string>, redirectTo?: string) {
  const asked: string[] = [];
  const get = async (url: string): Promise<Fetched | undefined> => {
    asked.push(url);
    const u = new URL(url);
    const final = redirectTo ? `${redirectTo}${u.pathname}` : url;
    const body = pages[u.pathname];
    return body === undefined ? { ok: false, url: final, text: '' } : { ok: true, url: final, text: body };
  };
  return { get, asked };
}

const crawl = defaultConfig().crawl;
const options = (get: (u: string) => Promise<Fetched | undefined>, robotsSitemaps: string[] = [], maxPages = 5, strategy?: 'random' | 'adaptive') => ({
  get,
  robotsSitemaps,
  maxPages,
  ...(strategy ? { strategy } : {}),
  siteOf,
  pageKey: (u: string) => pageKey(u),
  select: (locs: string[], sites: Set<string>) => selectCrawlLinks(locs, 'https://canada.ca/', sites, crawl),
});

describe('parseSitemapXml', () => {
  it('reads <loc> values, entities and CDATA, and tells an index apart', () => {
    const xml = urlset(['https://a.org/x?a=1&amp;b=2']) + '<url><loc><![CDATA[https://a.org/y]]></loc></url>';
    expect(parseSitemapXml(xml)).toEqual({ locs: ['https://a.org/x?a=1&b=2', 'https://a.org/y'], isIndex: false });
    expect(parseSitemapXml(index(['https://a.org/s1.xml'])).isIndex).toBe(true);
  });
});

describe('parseRobotsSitemaps', () => {
  it('reads Sitemap lines from any group', () => {
    const robots = 'User-agent: *\nDisallow: /admin\n\nSitemap: https://a.org/sitemap-en.xml\nsitemap:https://a.org/s2.xml # two';
    expect(parseRobotsSitemaps(robots)).toEqual(['https://a.org/sitemap-en.xml', 'https://a.org/s2.xml']);
  });
});

describe('seededSample', () => {
  const items = Array.from({ length: 100 }, (_, i) => `https://a.org/p${i}`);

  it('gives the same sample for the same site, whatever the input order', () => {
    const a = seededSample(items, 10, 'a.org');
    expect(seededSample([...items].reverse(), 10, 'a.org')).toEqual(a);
    expect(new Set(a).size).toBe(10);
  });

  // The sample must not move when sampling code changes: re-scans compare
  // like with like only while the same site gives the same pages. Changed
  // once, deliberately, from a seeded shuffle to the URL-hash order, which
  // the next test shows keeps its pages as a sitemap changes.
  it('is unchanged from earlier releases (url-hash order)', () => {
    const pool = Array.from({ length: 40 }, (_, i) => `https://www.cms.gov/p/${(i * 7919) % 10007}`);
    expect(seededSample(pool, 4, 'canada.ca')).toEqual([
      'https://www.cms.gov/p/7842',
      'https://www.cms.gov/p/5321',
      'https://www.cms.gov/p/5398',
      'https://www.cms.gov/p/9930',
    ]);
  });

  it('keeps nearly all of its pages when the sitemap gains or loses some', () => {
    const base = Array.from({ length: 4000 }, (_, i) => `https://www.a.gov/s${i % 40}/page-${i}`);
    const grown = [...base, ...Array.from({ length: 200 }, (_, i) => `https://www.a.gov/s${i % 40}/new-${i}`)];
    const shrunk = base.filter((_, i) => i % 50 !== 7);
    const kept = (a: string[], b: string[]) => a.filter((u) => b.includes(u)).length;
    const s0 = seededSample(base, 20, 'a.gov');
    // A page leaves the sample only when a new page outranks it, or it leaves the sitemap.
    expect(kept(s0, seededSample(grown, 20, 'a.gov'))).toBeGreaterThanOrEqual(17);
    expect(kept(s0, seededSample(shrunk, 20, 'a.gov'))).toBeGreaterThanOrEqual(18);
  });

  it('ignores the scheme and www. when ordering, so a site moving to https keeps its sample', () => {
    const https = Array.from({ length: 50 }, (_, i) => `https://www.a.gov/p${i}`);
    const http = https.map((u) => u.replace('https://www.', 'http://'));
    expect(seededSample(http, 5, 'a.gov').map((u) => u.replace('http://', 'https://www.'))).toEqual(seededSample(https, 5, 'a.gov'));
  });

  it('gives another sample for another site, and everything when there are few', () => {
    expect(seededSample(items, 10, 'b.org')).not.toEqual(seededSample(items, 10, 'a.org'));
    expect(seededSample(items.slice(0, 3), 10, 'a.org')).toHaveLength(3);
  });
});

describe('sampleFromSitemaps', () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://www.canada.ca/en/page-${i}.html`);

  it('follows the www redirect, reads the sitemap and keeps only scannable same-site pages', async () => {
    const { get } = site(
      {
        '/sitemap.xml': urlset([
          ...many,
          'https://www.canada.ca/etc/designs/theme.min.css', // not a page (open-scans scanned these)
          'https://www.canada.ca/en/report.pdf',
          'https://elsewhere.org/en/page.html',
        ]),
      },
      'https://www.canada.ca',
    );
    const sample = await sampleFromSitemaps('https://canada.ca/', options(get));
    expect(sample!.urls[0]).toBe('https://canada.ca/');
    expect(sample!.urls).toHaveLength(5);
    expect(sample!.listed).toBe(40);
    expect(sample!.source).toBe('https://www.canada.ca/sitemap.xml');
    for (const u of sample!.urls.slice(1)) expect(u).toMatch(/^https:\/\/www\.canada\.ca\/en\/page-\d+\.html$/);
  });

  it('prefers sitemaps named in robots.txt and samples a few children of an index', async () => {
    const children = Array.from({ length: 6 }, (_, i) => `https://canada.ca/s${i}.xml`);
    const pages: Record<string, string> = { '/main-index.xml': index(children) };
    children.forEach((c, i) => (pages[new URL(c).pathname] = urlset([`https://canada.ca/c${i}/a.html`, `https://canada.ca/c${i}/b.html`])));
    const { get, asked } = site(pages);
    const sample = await sampleFromSitemaps('https://canada.ca/', options(get, ['https://canada.ca/main-index.xml', 'https://other.org/x.xml']));
    expect(asked[0]).toBe('https://canada.ca/main-index.xml');
    expect(asked.some((u) => u.startsWith('https://other.org'))).toBe(false);
    // Three of six children read, two pages each.
    expect(asked.filter((u) => /\/s\d\.xml$/.test(u))).toHaveLength(3);
    expect(sample!.listed).toBe(6);
  });

  it('reads content sitemaps before attachment, author, tag and category ones', async () => {
    const names = ['post-sitemap.xml', 'page-sitemap.xml', 'attachment-sitemap.xml', 'author-sitemap.xml', 'category-sitemap.xml', 'post_tag-sitemap.xml'];
    const pages: Record<string, string> = { '/sitemap_index.xml': index(names.map((n) => `https://canada.ca/${n}`)) };
    for (const n of names) pages[`/${n}`] = urlset([`https://canada.ca/${n.replace('.xml', '')}/a.html`]);
    const { get, asked } = site(pages);
    const sample = await sampleFromSitemaps('https://canada.ca/', options(get, ['https://canada.ca/sitemap_index.xml']));
    const children = asked.filter((u) => /-sitemap\.xml$/.test(u)).map((u) => u.split('/').pop());
    // Only the content sitemaps: thin ones are read only when there is nothing else.
    expect(children.sort()).toEqual(['page-sitemap.xml', 'post-sitemap.xml']);
    expect(sample!.urls.some((u) => u.includes('/post-sitemap/'))).toBe(true);
  });

  it('is the same sample on a re-scan', async () => {
    const pages = { '/sitemap.xml': urlset(many) };
    const a = await sampleFromSitemaps('https://canada.ca/', options(site(pages).get));
    const b = await sampleFromSitemaps('https://canada.ca/', options(site(pages).get));
    expect(a!.urls).toEqual(b!.urls);
  });

  it('returns nothing when no sitemap lists a scannable page, so the crawl can follow links', async () => {
    expect(await sampleFromSitemaps('https://canada.ca/', options(site({}).get))).toBeUndefined();
    const onlyHome = site({ '/sitemap.xml': urlset(['https://canada.ca/']) });
    expect(await sampleFromSitemaps('https://canada.ca/', options(onlyHome.get))).toBeUndefined();
  });
});

describe('adaptiveSample', () => {
  /** A site with one huge section, two mid-sized ones and a few tiny ones. */
  const groups = () =>
    new Map<string, string[]>([
      ['/guidance', Array.from({ length: 800 }, (_, i) => `https://a.org/guidance/t/r${i}`)],
      ['/medicare', Array.from({ length: 150 }, (_, i) => `https://a.org/medicare/x/m${i}`)],
      ['/news', Array.from({ length: 40 }, (_, i) => `https://a.org/news/n${i}`)],
      ['/careers', ['https://a.org/careers/apply']],
      ['/espanol', ['https://a.org/espanol/inicio', 'https://a.org/espanol/ayuda']],
      ['/tools', ['https://a.org/tools/calculator']],
    ]);

  it('takes one page per common section first, keeps some for rare ones, then shares the rest by size', () => {
    const { picks, picked, rare } = adaptiveSample(groups(), 10, 'a.org');
    expect(picks).toHaveLength(10);
    expect(picks.slice(0, 3).map((p) => [p.key, p.reason])).toEqual([
      ['/guidance', 'representative'],
      ['/medicare', 'representative'],
      ['/news', 'representative'],
    ]);
    expect([...rare].sort()).toEqual(['/careers', '/espanol', '/tools']);
    expect(picks.filter((p) => p.reason === 'rare-section')).toHaveLength(2);
    // The largest section gets most of the proportional share.
    expect(picked.get('/guidance')).toBeGreaterThan(picked.get('/medicare')!);
    expect(new Set(picks.map((p) => p.url)).size).toBe(10);
  });

  it('is deterministic, and does not depend on the order pages are listed in', () => {
    const a = adaptiveSample(groups(), 10, 'a.org').picks;
    const reversed = new Map([...groups()].reverse().map(([k, v]) => [k, [...v].reverse()]));
    expect(adaptiveSample(reversed, 10, 'a.org').picks).toEqual(a);
    expect(adaptiveSample(groups(), 10, 'b.org').picks).not.toEqual(a);
  });

  it('keeps its picks when sections gain pages, or a new section appears', () => {
    const a = adaptiveSample(groups(), 10, 'a.org').picks.map((p) => p.url);
    const grown = groups();
    grown.set('/guidance', [...grown.get('/guidance')!, ...Array.from({ length: 40 }, (_, i) => `https://a.org/guidance/t/new${i}`)]);
    grown.set('/press', Array.from({ length: 30 }, (_, i) => `https://a.org/press/p${i}`));
    const b = adaptiveSample(grown, 10, 'a.org').picks.map((p) => p.url);
    // The new section takes a representative's place; the rest stay.
    expect(a.filter((u) => b.includes(u)).length).toBeGreaterThanOrEqual(7);
  });

  it('keeps no rare share for a tiny budget, and stops when pages run out', () => {
    expect(adaptiveSample(groups(), 3, 'a.org').picks.every((p) => p.reason === 'representative')).toBe(true);
    const few = new Map([['/a', ['https://a.org/a/1']], ['/b', ['https://a.org/b/1', 'https://a.org/b/2']]]);
    expect(adaptiveSample(few, 10, 'a.org').picks).toHaveLength(3);
  });
});

describe('sampleFromSitemaps, adaptive', () => {
  const sections = ['news', 'events', 'services'];
  const locs = [
    ...sections.flatMap((s, si) => Array.from({ length: 20 * (si + 1) }, (_, i) => `https://canada.ca/${s}/item-${i}`)),
    'https://canada.ca/jobs/apply',
  ];

  it('spreads the sample across sections and records them', async () => {
    const { get } = site({ '/sitemap.xml': urlset(locs) });
    const sample = await sampleFromSitemaps('https://canada.ca/', options(get, [], 8, 'adaptive'));
    expect(sample!.urls[0]).toBe('https://canada.ca/');
    expect(sample!.urls).toHaveLength(8);
    const sectionsHit = new Set(sample!.urls.slice(1).map((u) => new URL(u).pathname.split('/')[1]));
    expect(sectionsHit).toEqual(new Set(['news', 'events', 'services', 'jobs']));
    expect(sample!.reasons['https://canada.ca/jobs/apply']).toBe('rare-section');
    expect(sample!.strata!.map((s) => [s.section, s.listed])).toEqual([['/services', 60], ['/events', 40], ['/news', 20], ['/jobs', 1]]);
    expect(sample!.strata!.reduce((t, s) => t + s.picked, 0)).toBe(7);
  });

  it('leaves the default sample as it was', async () => {
    const pages = { '/sitemap.xml': urlset(locs) };
    const random = await sampleFromSitemaps('https://canada.ca/', options(site(pages).get, [], 8));
    expect(random!.strata).toBeUndefined();
    expect(Object.values(random!.reasons).every((r) => r === 'random')).toBe(true);
    expect(random!.urls.slice(1)).toEqual(seededSample(locs, 7, 'canada.ca'));
  });

  it('splits strata by child sitemap and says how many children were read', async () => {
    const children = ['post-sitemap.xml', 'page-sitemap.xml'];
    const pages: Record<string, string> = { '/sitemap_index.xml': index(children.map((c) => `https://canada.ca/${c}`)) };
    pages['/post-sitemap.xml'] = urlset(Array.from({ length: 30 }, (_, i) => `https://canada.ca/post-${i}`));
    pages['/page-sitemap.xml'] = urlset(['https://canada.ca/about', 'https://canada.ca/contact', 'https://canada.ca/team']);
    const sample = await sampleFromSitemaps('https://canada.ca/', options(site(pages).get, ['https://canada.ca/sitemap_index.xml'], 6, 'adaptive'));
    expect(sample!.strata!.map((s) => s.sitemap).sort()).toEqual(['page-sitemap.xml', 'post-sitemap.xml']);
    expect(sample!.urls.some((u) => /about|contact|team/.test(u))).toBe(true);
    expect([sample!.sitemapsListed, sample!.sitemapsRead]).toEqual([2, 2]);
  });
});

describe('describeSample', () => {
  const keyOf = (u: string) => pageKey(u);

  it('records why each measured page is there and what the sample cannot stand for', () => {
    const s = describeSample({
      sample: {
        urls: ['https://a.org/', 'https://a.org/x/1', 'https://a.org/y/1'],
        source: 'https://a.org/sitemap.xml',
        listed: 40,
        capped: false,
        sitemapsListed: 9,
        sitemapsRead: 3,
        reasons: { 'https://a.org/x/1': 'representative', 'https://a.org/y/1': 'rare-section' },
        strata: [
          { section: '/x', listed: 39, picked: 1, rare: false, pages: ['https://a.org/x/1'] },
          { section: '/y', listed: 1, picked: 1, rare: true, pages: ['https://a.org/y/1'] },
        ],
      },
      adaptive: true,
      // The rare page was cut by the page limit; a listed page took its place.
      measured: ['https://a.org/', 'https://a.org/listed', 'https://a.org/x/1'],
      startKey: keyOf('https://a.org/'),
      extraKeys: new Set([keyOf('https://a.org/listed')]),
      requested: 1,
      keyOf,
    });
    expect(s.method).toBe('adaptive');
    expect(s.reasons).toEqual({ 'https://a.org/': 'start', 'https://a.org/listed': 'requested', 'https://a.org/x/1': 'representative' });
    expect(s.strata!.map((x) => x.picked)).toEqual([1, 0]);
    expect(s.limitations!.join(' ')).toMatch(/names 9 sitemaps and 3 were read/);
  });

  it('says a link crawl leans towards the start page', () => {
    const s = describeSample({ sample: undefined, adaptive: false, measured: ['https://a.org/', 'https://a.org/b'], startKey: 'a.org/', extraKeys: new Set(), requested: 0, keyOf });
    expect(s).toMatchObject({ method: 'links', picked: 2, reasons: { 'https://a.org/': 'start', 'https://a.org/b': 'linked' } });
    expect(s.limitations![0]).toMatch(/following links/);
  });
});
