import { describe, it, expect } from 'vitest';
import { pageKey, sameSite, siteOf } from '../src/collect/urls.js';
import { selectCrawlLinks } from '../src/collect/crawler.js';

const crawl = { same_origin: true, query_strategy: 'strip' as const, include: [], exclude: [] };

describe('siteOf / sameSite', () => {
  it('treats www and non-www, http and https as one site', () => {
    expect(siteOf('https://www.france.fr/en/')).toBe('france.fr');
    expect(siteOf('http://france.fr/')).toBe('france.fr');
    expect(sameSite('http://cms.gov/', 'https://www.cms.gov/about')).toBe(true);
  });

  it('keeps other subdomains and other domains apart', () => {
    expect(sameSite('https://france.fr/', 'https://shop.france.fr/')).toBe(false);
    expect(sameSite('https://france.fr/', 'https://example.org/')).toBe(false);
    expect(siteOf('mailto:a@france.fr')).toBe('');
  });
});

describe('pageKey', () => {
  it('gives http/https and www/non-www spellings of a page one identity', () => {
    const k = pageKey('https://www.france.fr/en/article/x/');
    expect(pageKey('http://france.fr/en/article/x')).toBe(k);
    expect(pageKey('https://france.fr/en/article/x#top')).toBe(k);
  });

  it('still tells different pages apart', () => {
    expect(pageKey('https://france.fr/en/a')).not.toBe(pageKey('https://france.fr/en/b'));
  });
});

describe('selectCrawlLinks', () => {
  /**
   * Regression, issue #11: https://france.fr/ redirects to
   * https://www.france.fr/en/, whose links are all on www.france.fr. They were
   * compared with the requested origin (france.fr), every one was rejected,
   * and the crawl stopped after one page.
   */
  it('follows links on the redirect target of the start URL', () => {
    const sites = new Set([siteOf('https://france.fr/')]);
    const links = selectCrawlLinks(
      ['https://www.france.fr/en/activities', '/en/archives', 'https://www.france.fr/fr/'],
      'https://www.france.fr/en/',
      sites,
      crawl,
    );
    expect(links).toEqual([
      'https://www.france.fr/en/activities',
      'https://www.france.fr/en/archives',
      'https://www.france.fr/fr',
    ]);
  });

  it('crawls a cross-domain redirect target once it is in scope', () => {
    const sites = new Set(['old.example', 'new.example']);
    expect(selectCrawlLinks(['https://new.example/a'], 'https://new.example/', sites, crawl)).toEqual([
      'https://new.example/a',
    ]);
  });

  it('lists a page once whatever scheme or www spelling links to it', () => {
    const links = selectCrawlLinks(
      ['http://france.fr/en/x', 'https://www.france.fr/en/x', 'https://france.fr/en/x/'],
      'https://www.france.fr/en/',
      new Set(['france.fr']),
      crawl,
    );
    expect(links).toHaveLength(1);
  });

  it('skips other sites, mailto links and files', () => {
    const links = selectCrawlLinks(
      ['https://twitter.com/france', 'mailto:info@france.fr', '/docs/guide.pdf', '/img/hero.JPG', '/en/ok'],
      'https://www.france.fr/en/',
      new Set(['france.fr']),
      crawl,
    );
    expect(links).toEqual(['https://www.france.fr/en/ok']);
  });

  it('still applies include rules and robots.txt', () => {
    const links = selectCrawlLinks(
      ['/en/a', '/fr/b', '/en/private/c'],
      'https://www.france.fr/',
      new Set(['france.fr']),
      { ...crawl, include: ['^/en/'] },
      ['/en/private'],
    );
    expect(links).toEqual(['https://www.france.fr/en/a']);
  });
});
