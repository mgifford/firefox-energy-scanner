import { describe, it, expect } from 'vitest';
import {
  parseRobotsSitemaps,
  parseSitemapXml,
  sampleFromSitemaps,
  seededSample,
  type Fetched,
} from '../src/collect/sitemap.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';
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
const options = (get: (u: string) => Promise<Fetched | undefined>, robotsSitemaps: string[] = [], maxPages = 5) => ({
  get,
  robotsSitemaps,
  maxPages,
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
