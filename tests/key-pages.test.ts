import { describe, it, expect } from 'vitest';
import { findKeyPages, notFoundUrl, searchTerm } from '../src/collect/key-pages.js';
import { findSiteKeyPages } from '../src/collect/crawler.js';
import { sampleFromSitemaps } from '../src/collect/sitemap.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';
import { pageKey, siteOf } from '../src/collect/urls.js';
import { defaultConfig } from '../src/core/config.js';
import type { HeaderRequester, PageCheck } from '../src/collect/content-type.js';
import { parseUrlList } from '../src/collect/url-list.js';

/** A Drupal-style home page: a search block, main navigation, a footer. */
const drupal = `<!doctype html><html lang="en"><head><title>CMS.gov | Centers for Medicare &amp; Medicaid Services</title></head><body>
<header><form action="/search/cms" method="get" id="search-block-form" role="search">
  <label for="edit-keys">Search</label><input type="search" id="edit-keys" name="keys" value="">
  <input type="hidden" name="sort" value="relevance"><input type="submit" value="Search"></form>
<nav><a href="/medicare">Medicare</a><a href="https://twitter.com/cms">Twitter</a><a href="mailto:help@cms.gov">Email us</a></nav></header>
<main><h1>Welcome</h1></main>
<footer><a href="/about-cms/contact">Contact us</a> <a href="/about-cms/web-policies-important-links/accessibility-nondiscrimination-disclosures/accessibility">Accessibility</a>
<a href="https://www.hhs.gov/contact">Contact HHS</a></footer></body></html>`;

describe('finding key pages on a start page', () => {
  it('finds search, contact and the accessibility statement, on the same site only', () => {
    const found = findKeyPages(drupal, 'https://www.cms.gov/');
    expect(found).toEqual([
      { kind: 'search', url: 'https://www.cms.gov/search/cms?sort=relevance&keys=centers', from: 'the search form\'s "keys" field' },
      { kind: 'contact', url: 'https://www.cms.gov/about-cms/contact', from: 'the link "Contact us"' },
      { kind: 'accessibility', url: 'https://www.cms.gov/about-cms/web-policies-important-links/accessibility-nondiscrimination-disclosures/accessibility', from: 'the link "Accessibility"' },
    ]);
  });

  it('reads a WordPress search form, which searches the home page with ?s=', () => {
    const wp = `<title>Example News</title><form role="search" method="get" action="https://example.org/"><input type="search" name="s"></form>`;
    expect(findKeyPages(wp, 'https://example.org/')).toEqual([{ kind: 'search', url: 'https://example.org/?s=example', from: 'the search form\'s "s" field' }]);
  });

  it('ignores a search that posts, and forms that are not searches', () => {
    const html = `<form action="/search" method="post" role="search"><input name="q"></form><form action="/subscribe"><input name="email"></form>`;
    expect(findKeyPages(html, 'https://a.gov/')).toEqual([]);
  });

  it('finds a contact page by its address when the link text says nothing', () => {
    expect(findKeyPages('<a href="/en/contact/"><img alt=""></a>', 'https://a.gov/')).toEqual([{ kind: 'contact', url: 'https://a.gov/en/contact/', from: 'the address /en/contact/' }]);
  });

  it('searches for a word from the title, the same every time', () => {
    expect(searchTerm(drupal)).toBe('centers');
    expect(searchTerm('<title>Énergie Québec</title>')).toBe('énergie');
    expect(searchTerm('<title>A B</title>')).toBe('help');
  });
});

describe('a site’s key pages, checked against its rules', () => {
  const config = defaultConfig();
  const get = async (url: string) => ({ ok: true, url, text: drupal });
  const nf = notFoundUrl('https://www.cms.gov/');
  const answers = (nfAnswer: { status: number; type?: string; url?: string }): HeaderRequester => async (url) =>
    url === nf ? { status: nfAnswer.status, headers: nfAnswer.type ? { 'content-type': nfAnswer.type } : {}, url: nfAnswer.url ?? url } : undefined;

  it('adds the "not found" page when the site answers an unknown address with its own HTML page', async () => {
    const pages = await findSiteKeyPages('https://www.cms.gov/', get, answers({ status: 404, type: 'text/html; charset=utf-8' }), config, []);
    expect(pages.map((p) => p.kind)).toEqual(['search', 'contact', 'accessibility', 'not-found']);
    expect(pages[3]).toEqual({ kind: 'not-found', url: nf, from: 'an address the site does not have (HTTP 404)' });
  });

  it('leaves it out when the site redirects unknown addresses elsewhere, or answers in plain text', async () => {
    expect((await findSiteKeyPages('https://www.cms.gov/', get, answers({ status: 200, type: 'text/html', url: 'https://www.cms.gov/' }), config, [])).some((p) => p.kind === 'not-found')).toBe(false);
    expect((await findSiteKeyPages('https://www.cms.gov/', get, answers({ status: 404, type: 'text/plain' }), config, [])).some((p) => p.kind === 'not-found')).toBe(false);
  });

  it('respects robots.txt: a site that disallows its search results gets no search page', async () => {
    const pages = await findSiteKeyPages('https://www.cms.gov/', get, answers({ status: 404 }), config, ['/search/']);
    expect(pages.map((p) => p.kind)).toEqual(['contact', 'accessibility']);
  });

  it('respects include and exclude rules', async () => {
    const strict = { ...config, crawl: { ...config.crawl, exclude: ['/about-cms/'] } };
    expect((await findSiteKeyPages('https://www.cms.gov/', get, answers({ status: 404 }), strict, [])).map((p) => p.kind)).toEqual(['search']);
  });
});

describe('a sample cleaned before measuring', () => {
  const locs = Array.from({ length: 30 }, (_, i) => `https://a.gov/news/item-${i}`);
  const xml = `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
  const run = (check: (url: string) => Partial<PageCheck>, taken: string[] = []) =>
    sampleFromSitemaps('https://a.gov/', {
      get: async (url) => (new URL(url).pathname === '/sitemap.xml' ? { ok: true, url, text: xml } : { ok: false, url, text: '' }),
      robotsSitemaps: [],
      maxPages: 8,
      siteOf,
      pageKey: (u) => pageKey(u),
      select: (l, sites) => selectCrawlLinks(l, 'https://a.gov/', sites, defaultConfig().crawl),
      taken,
      checkPages: async (urls) => urls.map((url) => ({ url, verdict: 'html' as const, by: 'head' as const, ...check(url) })),
    });

  it('replaces pages that are gone, that redirect off the site, or that lead to a page already chosen', async () => {
    const sample = (await run((url) => {
      const n = Number(/item-(\d+)/.exec(url)![1]);
      if (n % 5 === 0) return { verdict: 'gone', status: 404 };
      if (n % 7 === 0) return { finalUrl: 'https://elsewhere.org/moved' };
      if (n % 3 === 0) return { finalUrl: 'https://a.gov/news/item-1' };
      return {};
    }))!;
    const ids = sample.urls.slice(1).map((u) => Number(/item-(\d+)/.exec(u)![1]));
    expect(sample.urls).toHaveLength(8);
    expect(ids.every((n) => n % 5 !== 0 && n % 7 !== 0)).toBe(true);
    // Of the pages that lead to item-1, only one stays in the sample.
    expect(ids.filter((n) => n === 1 || n % 3 === 0).length).toBeLessThanOrEqual(1);
    expect(sample.health).toMatchObject({ offSite: expect.any(Number), gone: expect.any(Number) });
    expect(sample.health!.gone + sample.health!.offSite + sample.health!.duplicates).toBeGreaterThan(0);
    expect(sample.gone!.every((g) => g.verdict === 'gone')).toBe(true);
  });

  it('does not draw pages already chosen as named or key pages', async () => {
    const taken = locs.slice(0, 25).map((u) => pageKey(u));
    const sample = (await run(() => ({}), taken))!;
    expect(sample.urls.slice(1).every((u) => !taken.includes(pageKey(u)))).toBe(true);
  });
});

describe('a list of pages to measure (--also-file)', () => {
  it('reads one URL a line, a CSV first column, or a sitemap', () => {
    expect(parseUrlList('# required pages\nhttps://a.gov/contact\n\nhttps://a.gov/search?q=x\r\n')).toEqual(['https://a.gov/contact', 'https://a.gov/search?q=x']);
    expect(parseUrlList('url,views\n"https://a.gov/",1200\nhttps://a.gov/news,300\n')).toEqual(['https://a.gov/', 'https://a.gov/news']);
    expect(parseUrlList('<?xml version="1.0"?><urlset><url><loc>https://a.gov/x</loc></url></urlset>')).toEqual(['https://a.gov/x']);
  });

  it('reads a list saved by top-task-finder, and other JSON lists', () => {
    const ttf = JSON.stringify({ requestId: 'cache-1', selectedUrls: ['https://cms.gov/', 'https://cms.gov/digital-service/digital-accessibility'], requestedCount: 100, totalDiscoveredPages: 9986 });
    expect(parseUrlList(ttf)).toEqual(['https://cms.gov/', 'https://cms.gov/digital-service/digital-accessibility']);
    expect(parseUrlList('["https://a.gov/", "not a url", 3]')).toEqual(['https://a.gov/']);
    expect(parseUrlList('[{"url": "https://a.gov/x", "views": 900}, {"title": "no url"}]')).toEqual(['https://a.gov/x']);
    expect(parseUrlList('{"broken": ')).toEqual([]);
  });
});
